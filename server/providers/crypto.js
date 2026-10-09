/**
 * 加密货币行情 Provider
 *
 * 选型说明（实测驱动，不是照抄文档）：
 *   行情源在国内/受限网络下的可用性差异极大，所以这里做的是**多源自动降级**，
 *   而不是「主源 + 一个备用源」。任一个源被墙 / 限流 / 返回空，都会自动往下走。
 *
 *   | 源 | 端点 | 定位 |
 *   |----|------|------|
 *   | Binance 公共行情 | data-api.binance.vision | 首选：一次批量拿全部币价，无额度限制 |
 *   | Gate.io 现货 | api.gateio.ws | 次选：一次批量拿全部交易对，覆盖面最广 |
 *   | OKX 现货 | www.okx.com | 再选：部分网络可直连 |
 *   | CoinGecko | api.coingecko.com | 兜底：额度最小的免费档 |
 *
 *   ⚠️ 为什么首选不是 CoinGecko/OKX：
 *   实测本机 DNS 对 `api.coingecko.com`（解析到 108.160.170.52）和 `www.okx.com`
 *   （解析到 169.254.0.2，链路本地地址）都返回了被污染的地址，TCP 443 完全连不上。
 *   这两个源一旦被选为「主源」，整个加密货币更新就会一直卡在超时上 —— 见下面
 *   `getPrices` 的批量策略与 `CIRCUIT` 熔断。
 *
 *   另外，`api.binance.com` 在本网络返回 451（地区限制），
 *   而官方公开行情域名 `data-api.binance.vision` 是可用的 —— 两者不要混为一谈。
 *
 * 设计要点：
 *  1. **多源降级**：按顺序尝试，拿到数据就停；每个源都有短超时。
 *  2. **熔断**：某个源连续失败后进入冷却期，冷却期内直接跳过，
 *     不会每次都先等它超时一遍（这是「更新一次要 90 秒」的主要来源）。
 *  3. **批量**：Binance / Gate.io 都支持一次请求拿到所有交易对，
 *     5 个币也只需要 1 次请求，而不是每个币 2 次。
 *  4. **限流器不会中毒**：早期版本 `chain = chain.then(...)` 在请求抛错后
 *     会把整条 Promise 链变成 rejected，之后再也不会恢复 —— 于是
 *     「第一次 429 之后，加密货币就再也拉不到行情了」。见 `withHostLock`。
 */

import { round } from '../util.js';

const CG_BASE = 'https://api.coingecko.com/api/v3';
const BINANCE_BASES = (process.env.STOCKVIEW_BINANCE_BASE
  ? [process.env.STOCKVIEW_BINANCE_BASE]
  : ['https://data-api.binance.vision']
).filter(Boolean);
const GATE = 'https://api.gateio.ws/api/v4';
const OKX = 'https://www.okx.com/api/v5';
const UA = 'stockview/1.0 (local personal ledger)';

/** 单次请求超时：宁可快速失败换源，也不要让用户在遮罩里干等 */
const TIMEOUT = 7000;
/** 走势 / 日线请求可以稍长一点 */
const TIMEOUT_CANDLE = 9000;

/* ============================================================ 熔断与限流 */

/**
 * 源的健康状态。连续失败到阈值就进入冷却，冷却期内不再浪费一次超时。
 * 这是把「每次更新 87 秒」压回「秒级」的关键：被墙的源只会在第一次付出代价。
 */
const CIRCUIT = {
  threshold: 2,
  cooldownMs: 5 * 60 * 1000,
  state: new Map(), // key -> { fails, downUntil, reason }
};

function circuitOf(key) {
  if (!CIRCUIT.state.has(key)) CIRCUIT.state.set(key, { fails: 0, downUntil: 0, reason: null });
  return CIRCUIT.state.get(key);
}

/** 该源当前是否被熔断（冷却中） */
function isDown(key) {
  const s = circuitOf(key);
  if (s.downUntil && Date.now() < s.downUntil) return s.reason || '冷却中';
  if (s.downUntil && Date.now() >= s.downUntil) {
    // 冷却结束：允许再试一次
    s.downUntil = 0;
    s.fails = 0;
    s.reason = null;
  }
  return null;
}

function markOk(key) {
  const s = circuitOf(key);
  s.fails = 0;
  s.downUntil = 0;
  s.reason = null;
}

function markFail(key, err) {
  const s = circuitOf(key);
  s.fails += 1;
  s.reason = err?.message ? String(err.message).slice(0, 120) : String(err).slice(0, 120);
  if (s.fails >= CIRCUIT.threshold) s.downUntil = Date.now() + CIRCUIT.cooldownMs;
}

/** 供设置页 / 自检展示的源状态 */
export function sourceStatus() {
  const now = Date.now();
  return [...CIRCUIT.state.entries()].map(([host, s]) => ({
    host,
    fails: s.fails,
    cooling: Boolean(s.downUntil && s.downUntil > now),
    resumeInMs: s.downUntil > now ? s.downUntil - now : 0,
    reason: s.reason,
  }));
}

/* ---------------------------------------------------- 按主机串行 + 最小间隔 */

const hostChain = new Map(); // host -> Promise
const hostLast = new Map(); // host -> ts
const HOST_MIN_INTERVAL = 250; // ms，公开接口给得很宽，这里只用来避免瞬时连击

/**
 * 按主机串行执行，并保证两次请求之间至少有 HOST_MIN_INTERVAL 的间隔。
 *
 * ⚠️ 这里必须自己兜住异常：早期版本是全局单链 `chain = chain.then(fn)`，
 * 只要有一个请求抛错，整条链就变成 rejected 状态且永远不会恢复 ——
 * 之后**每一次** `await throttle()` 都会立刻抛错，加密货币行情从此彻底失效。
 *
 * @param {string} host 源标识
 * @param {() => Promise<any>} task 真正要执行的事
 * @param {AbortSignal} [signal] 中止信号：排队期间被中止就不再发请求
 */
function withHostLock(host, task, signal) {
  const prev = hostChain.get(host) || Promise.resolve();
  const run = prev.then(async () => {
    // 排队期间可能已经被中止：这时**不要**再发请求，直接以中止结束。
    // 少了这一步，「中止更新」对排在队列后面的请求完全无效 ——
    // 用户点了停止，后面的请求还会一个接一个发完。
    if (signal?.aborted) throw abortError();
    const wait = HOST_MIN_INTERVAL - (Date.now() - (hostLast.get(host) || 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) throw abortError();
    hostLast.set(host, Date.now());
    return task();
  });
  // 链上只挂「已消化异常」的版本，业务结果仍由 run 返回给调用方
  hostChain.set(
    host,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/* ================================================================== HTTP */

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 40);
  }
}

/** 统一的中止错误：调用方靠 err.name === 'AbortError' 判断「是用户点了停止」而非取价失败 */
export function abortError(reason = '用户中止') {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

function aborted(err, signal) {
  return err?.name === 'AbortError' || signal?.aborted;
}

/** 中止信号已触发就直接抛 AbortError —— 在每个循环开头以及每个 await 之后调用 */
export function throwIfAborted(signal, reason) {
  if (signal?.aborted) throw abortError(reason);
}

/** 带超时 + 外部中止信号的 GET，返回已解析的 JSON */
async function httpJson(url, { timeout = TIMEOUT, signal, headers } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`超时（${timeout}ms）`)), timeout);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA, ...(headers || {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    // fetch 被 abort 时抛的是 AbortError，但我们要区分「用户中止」与「请求超时」：
    // 前者必须原样冒泡上去让整轮更新停下，后者只是这一个源失败、可以换源重试。
    if (signal?.aborted) throw abortError();
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 带熔断的一次源请求。
 * @param {string} key 熔断/限流用的源标识（一般取 host）
 * @param {(signal?: AbortSignal) => Promise<any>} fn
 * @param {AbortSignal} [signal]
 */
async function fromSource(key, fn, signal) {
  if (signal?.aborted) throw abortError();
  const cooling = isDown(key);
  if (cooling) {
    const err = new Error(`${key} 暂不可用（${cooling}）`);
    err.skipped = true;
    throw err;
  }
  try {
    const out = await withHostLock(key, () => fn(signal), signal);
    markOk(key);
    return out;
  } catch (err) {
    // 用户中止不算这个源的「失败」，别把它计进熔断
    if (!err?.skipped && err?.name !== 'AbortError') markFail(key, err);
    throw err;
  }
}

/* ============================================================ 币种符号解析 */

/**
 * 内置币种表（CoinGecko id → 交易所符号 + 中文名）。
 * 交易所路由用符号，CoinGecko 路由用 id，两者必须成对维护。
 * `alias` 是在不同交易所上的额外符号（如 LUNA/ LUNC 这类改名币）。
 */
export const COMMON_COINS = [
  { id: 'bitcoin', symbol: 'BTC', name: '比特币' },
  { id: 'ethereum', symbol: 'ETH', name: '以太坊' },
  { id: 'tether', symbol: 'USDT', name: '泰达币' },
  { id: 'binancecoin', symbol: 'BNB', name: '币安币' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
  { id: 'ripple', symbol: 'XRP', name: '瑞波币' },
  { id: 'dogecoin', symbol: 'DOGE', name: '狗狗币' },
  { id: 'cardano', symbol: 'ADA', name: '艾达币' },
  { id: 'tron', symbol: 'TRX', name: '波场' },
  { id: 'avalanche-2', symbol: 'AVAX', name: '雪崩' },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink' },
  { id: 'polkadot', symbol: 'DOT', name: '波卡' },
  { id: 'litecoin', symbol: 'LTC', name: '莱特币' },
  { id: 'uniswap', symbol: 'UNI', name: 'Uniswap' },
  { id: 'toncoin', symbol: 'TON', name: 'Toncoin' },
  { id: 'usd-coin', symbol: 'USDC', name: 'USD Coin' },
  { id: 'shiba-inu', symbol: 'SHIB', name: '柴犬币' },
  { id: 'matic-network', symbol: 'POL', name: 'Polygon' },
  { id: 'polygon-ecosystem-token', symbol: 'POL', name: 'Polygon' },
  { id: 'stellar', symbol: 'XLM', name: '恒星币' },
  { id: 'near', symbol: 'NEAR', name: 'NEAR' },
  { id: 'aptos', symbol: 'APT', name: 'Aptos' },
  { id: 'arbitrum', symbol: 'ARB', name: 'Arbitrum' },
  { id: 'optimism', symbol: 'OP', name: 'Optimism' },
  { id: 'filecoin', symbol: 'FIL', name: 'Filecoin' },
  { id: 'cosmos', symbol: 'ATOM', name: 'Cosmos' },
  { id: 'ethereum-classic', symbol: 'ETC', name: '以太坊经典' },
  { id: 'bitcoin-cash', symbol: 'BCH', name: '比特币现金' },
  { id: 'pepe', symbol: 'PEPE', name: 'Pepe' },
  { id: 'sui', symbol: 'SUI', name: 'Sui' },
  { id: 'the-open-network', symbol: 'TON', name: 'Toncoin' },
];

const COIN_BY_ID = new Map(COMMON_COINS.map((c) => [c.id, c]));

/**
 * 把一个「币种」解析成交易所基础符号（BTC / ETH / USDT …）。
 *
 * 三级解析，与早期版本一致但更严格：
 *   1. 调用方给的符号提示（新增记录时用户填的 symbol，最准）
 *   2. 内置币种表（CoinGecko id → 符号）
 *   3. id 大写（去掉非字母数字）
 *
 * ⚠️ 早期版本直接拿 id 大写去猜 OKX 交易对（`BITCOIN-USDT`），
 * OKX 对不存在的交易对返回 200 + `code:"51001"` 空数据，不抛异常，
 * 于是「备用源」静默失效 —— 这里最终还会用交易所的交易对清单校验一次。
 */
export function baseSymbolOf(coinId, symbolHint) {
  const hint = String(symbolHint || '')
    .trim()
    .toUpperCase();
  if (hint && /^[A-Z0-9]{1,15}$/.test(hint)) return hint;
  const id = String(coinId || '')
    .trim()
    .toLowerCase();
  const known = COIN_BY_ID.get(id);
  if (known) return known.symbol;
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* ============================================================ 现价（批量） */

/**
 * 交易所报价的统一形状：
 *   { priceUsd, change24h, lastUpdatedAt, pair, source }
 * USDT / USDC 都按 1 美元处理（与项目既有的 USD/CNY 口径一致）。
 */

/**
 * 稳定币的计价对要反过来写。
 *
 * ⚠️ 这是一个真实踩过的坑：CoinGecko 的 id `tether` → 符号 `USDT`，
 * 于是拼出的交易对是 `USDTUSDT` —— **不存在的交易对**。
 * 而 Binance 对「批量查价里混进一个非法 symbol」返回的是
 * `HTTP 400 {"code":-1121,"msg":"Invalid symbol."}`，**整批都拿不到**，
 * 5 个币因此全军覆没（并连带把后面的源也拖进超时）。
 * 所以稳定币必须显式换成「用另一种稳定币计价」。
 */
const STABLE_QUOTES = {
  USDT: ['USDC', 'FDUSD', 'BUSD', 'TUSD'],
  USDC: ['USDT', 'FDUSD', 'BUSD'],
  FDUSD: ['USDT', 'USDC'],
  TUSD: ['USDT', 'USDC'],
  BUSD: ['USDT', 'USDC'],
  DAI: ['USDT', 'USDC'],
};

/** 基础符号 → 该交易所在 USDT/USDC 计价下的候选交易对（顺序即优先级） */
function candidatePairs(base) {
  const b = String(base || '').toUpperCase();
  if (!b) return [];
  const stables = STABLE_QUOTES[b];
  if (stables) return stables.map((q) => ({ base: b, quote: q }));
  return [
    { base: b, quote: 'USDT' },
    { base: b, quote: 'USDC' },
  ];
}

/**
 * 有些交易所只挂了「反向」的交易对（例如 Binance 没有 `USDTUSDC`，
 * 只有 `USDCUSDT`）。这里把候选交易对映射到该所真实存在的那个，
 * 并标记是否需要把价格取倒数 —— 否则稳定币就只能掉到最慢的兜底源上去。
 *
 * @returns {{base:string, quote:string, invert:boolean}|null}
 */
function resolvePair(base, tradable) {
  for (const c of candidatePairs(base)) {
    if (!tradable || tradable.has(`${c.base}${c.quote}`)) return { ...c, invert: false };
    if (tradable.has(`${c.quote}${c.base}`)) return { base: c.quote, quote: c.base, invert: true };
  }
  return null;
}

/** 把一次交易所报价换算成统一形状；invert 时取倒数并反号涨跌幅 */
function toQuote(id, entry, { price, change24h, lastUpdatedAt, source }) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  return [
    id,
    {
      priceUsd: entry.invert ? round(1 / p, 8) : p,
      change24h: Number.isFinite(change24h) ? (entry.invert ? -change24h : change24h) : null,
      lastUpdatedAt,
      pair: `${entry.base}-${entry.quote}`,
      source,
    },
  ];
}

/** 按「已经确认存在的交易对」筛选，并记录每个币种选中的交易对 */
function planFor(pairs, tradable) {
  const out = [];
  for (const p of pairs) {
    const hit = resolvePair(p.base, tradable);
    if (hit) out.push({ id: p.id, base: hit.base, quote: hit.quote, pair: `${hit.base}${hit.quote}`, invert: hit.invert });
  }
  return out;
}

/** 交易所元数据缓存：交易对清单，用来避免「交易对不存在 → 整批 400 / 200 空数据」的静默失败 */
const symbolCache = { binance: { at: 0, set: null }, gate: { at: 0, set: null } };
const SYMBOL_TTL = 6 * 60 * 60 * 1000;

async function binanceTradable(signal) {
  if (symbolCache.binance.set && Date.now() - symbolCache.binance.at < SYMBOL_TTL) return symbolCache.binance.set;
  const data = await httpJson(`${BINANCE_BASES[0]}/api/v3/exchangeInfo`, { timeout: TIMEOUT_CANDLE, signal });
  const set = new Set(
    (data?.symbols || [])
      .filter((s) => s.status === 'TRADING' && (s.quoteAsset === 'USDT' || s.quoteAsset === 'USDC'))
      .map((s) => `${s.baseAsset}${s.quoteAsset}`),
  );
  symbolCache.binance = { at: Date.now(), set };
  return set;
}

async function gateTradable(signal) {
  if (symbolCache.gate.set && Date.now() - symbolCache.gate.at < SYMBOL_TTL) return symbolCache.gate.set;
  const rows = await httpJson(`${GATE}/spot/currency_pairs`, { timeout: TIMEOUT_CANDLE, signal });
  const set = new Set(
    (rows || [])
      .filter((r) => r.trade_status === 'tradable' && (r.quote === 'USDT' || r.quote === 'USDC'))
      .map((r) => `${r.base}${r.quote}`),
  );
  symbolCache.gate = { at: Date.now(), set };
  return set;
}

/**
 * 交易所时间戳可能是秒或毫秒 */
function tsToIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

/**
 * Binance：一次 `ticker/24hr?symbols=[...]` 拿到全部币种。
 * 分批（每批 60 个）是为了让「某一个交易对意外非法」最多只毁掉一批，而不是整轮更新。
 */
async function binanceQuotes(pairs, signal) {
  const tradable = await binanceTradable(signal);
  const use = planFor(pairs, tradable);
  if (!use.length) return new Map();
  const out = new Map();
  const put = (entry, raw) => {
    const kv = toQuote(entry.id, entry, raw);
    if (kv) out.set(kv[0], kv[1]);
  };
  for (let i = 0; i < use.length; i += 60) {
    const batch = use.slice(i, i + 60);
    try {
      const url = `${BINANCE_BASES[0]}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(batch.map((p) => p.pair)))}`;
      const data = await httpJson(url, { timeout: TIMEOUT_CANDLE, signal });
      const rows = Array.isArray(data) ? data : [data];
      const byPair = new Map(rows.map((r) => [String(r.symbol || '').toUpperCase(), r]));
      for (const p of batch) {
        const r = byPair.get(p.pair);
        if (!r) continue;
        put(p, {
          price: r.lastPrice,
          change24h: Number(r.priceChangePercent),
          lastUpdatedAt: tsToIso(r.closeTime || r.openTime),
          source: 'binance',
        });
      }
    } catch (err) {
      if (aborted(err, signal)) throw err;
      // 该批有非法 symbol（Binance 对整批返回 400）：逐个降级重试一次
      for (const p of batch) {
        try {
          const r = await httpJson(`${BINANCE_BASES[0]}/api/v3/ticker/24hr?symbol=${encodeURIComponent(p.pair)}`, {
            timeout: TIMEOUT,
            signal,
          });
          put(p, {
            price: r?.lastPrice,
            change24h: Number(r?.priceChangePercent),
            lastUpdatedAt: tsToIso(r?.closeTime || r?.openTime),
            source: 'binance',
          });
        } catch (one) {
          if (aborted(one, signal)) throw one;
        }
      }
    }
  }
  return out;
}

/** Gate.io：一次 `spot/tickers` 拿到全部交易对，覆盖面比 Binance 更广 */
async function gateQuotes(pairs, signal) {
  const tradable = await gateTradable(signal).catch(() => null);
  const use = planFor(pairs, tradable);
  if (!use.length) return new Map();
  const rows = await httpJson(`${GATE}/spot/tickers`, { timeout: TIMEOUT_CANDLE, signal });
  const byPair = new Map((rows || []).map((r) => [String(r.currency_pair || '').toUpperCase(), r]));
  const out = new Map();
  for (const p of use) {
    const r = byPair.get(p.pair);
    if (!r) continue;
    const kv = toQuote(p.id, p, {
      price: r.last,
      change24h: Number(r.change_percentage),
      lastUpdatedAt: null,
      source: 'gate',
    });
    if (kv) out.set(kv[0], kv[1]);
  }
  return out;
}

/**
 * OKX：按交易对逐个查（没有批量接口），只作为第三顺位。
 * OKX 不可达时（本机实测 DNS 被污染到 169.254.0.2）每次请求都要等满超时，
 * 所以在单次调用里也做了快速放弃：连续两个交易对超时就整源放弃，
 * 否则 5 个币会白等 5 × 2 × 7 秒。
 */
async function okxQuotes(pairs, signal) {
  const out = new Map();
  let consecutiveFails = 0;
  for (const p of pairs) {
    const cands = candidatePairs(p.base).map((c) => `${c.base}-${c.quote}`);
    let got = false;
    for (const pair of cands) {
      try {
        const data = await httpJson(`${OKX}/market/ticker?instId=${encodeURIComponent(pair)}`, { timeout: TIMEOUT, signal });
        const t = data?.data?.[0];
        const price = Number(t?.last);
        if (!t || !Number.isFinite(price) || price <= 0) continue;
        const open24h = Number(t.open24h);
        out.set(p.id, {
          priceUsd: price,
          change24h: Number.isFinite(open24h) && open24h > 0 ? ((price - open24h) / open24h) * 100 : null,
          lastUpdatedAt: tsToIso(t.ts),
          pair,
          source: 'okx',
        });
        got = true;
        break;
      } catch (err) {
        if (aborted(err, signal)) throw err;
        consecutiveFails += 1;
        if (consecutiveFails >= 2) return out; // 整源放弃，交给下一个源
      }
    }
    if (got) consecutiveFails = 0;
  }
  return out;
}

/** CoinGecko：额度最小的兜底源，一次拿全部币种 */
async function cgQuotes(pairs, signal) {
  const ids = pairs.map((p) => p.id);
  const data = await httpJson(
    `${CG_BASE}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`,
    { timeout: TIMEOUT, signal },
  );
  const out = new Map();
  for (const p of pairs) {
    const v = data?.[p.id];
    const price = Number(v?.usd);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.set(p.id, {
      priceUsd: price,
      change24h: Number.isFinite(Number(v.usd_24h_change)) ? Number(v.usd_24h_change) : null,
      lastUpdatedAt: v.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString() : null,
      pair: p.id,
      source: 'coingecko',
    });
  }
  return out;
}

/**
 * 批量现价（USD + 24h 涨跌）。
 * 依次尝试 Binance → Gate.io → OKX → CoinGecko，拿到多少算多少，
 * 缺失的币再交给下一个源补。
 *
 * @param {string[]} ids 币种标识（CoinGecko id 或币安符号，两者都认）
 * @param {Record<string,string>} [symbolMap] 币种 id → 交易所符号
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Map<string, {priceUsd:number, change24h:number|null, source:string}>>}
 */
export async function fetchPrices(ids, symbolMap = {}, options = {}) {
  const { signal } = options;
  const list = [...new Set((ids || []).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;

  const pairs = list.map((id) => ({ id, base: baseSymbolOf(id, symbolMap[id]) })).filter((p) => p.base);
  const pending = () => pairs.filter((p) => !out.has(p.id) && p.base);

  const sources = [
    ['binance', (sig) => binanceQuotes(pending(), sig)],
    ['gate', (sig) => gateQuotes(pending(), sig)],
    ['okx', (sig) => okxQuotes(pending(), sig)],
    ['coingecko', (sig) => cgQuotes(pending(), sig)],
  ];

  for (const [key, run] of sources) {
    throwIfAborted(signal);
    const rest = pending();
    if (!rest.length) break;
    if (isDown(key)) continue;
    try {
      const got = await fromSource(key, () => run(signal), signal);
      for (const [id, q] of got) if (!out.has(id)) out.set(id, q);
      if (got.size === 0) markFail(key, new Error('该源没有这些币种'));
    } catch (err) {
      if (aborted(err, signal)) throw err;
      /* 换下一个源 */
    }
  }
  return out;
}

/**
 * 带 60s 缓存的现价查询（同一分钟内重复调用不会重复打接口）。
 * 缓存按参数分别存储 —— 早期版本只存了一个值，导致
 * getPrices(['bitcoin']) 之后 getPrices(['ethereum']) 会拿到 bitcoin 的结果。
 */
const priceCache = new Map(); // key -> { at, value }
const PRICE_TTL = 60_000;

export async function getPrices(ids, symbolMap = {}, options = {}) {
  const list = [...new Set((ids || []).filter(Boolean))].sort();
  const key = JSON.stringify([list, list.map((id) => symbolMap[id] || '')]);
  const hit = priceCache.get(key);
  if (!options.fresh && hit && Date.now() - hit.at < PRICE_TTL) return hit.value;
  const value = await fetchPrices(list, symbolMap, options);
  // 全空的结果不缓存：否则一次网络抖动会让界面「一分钟内怎么点都是失败」
  if (value.size) {
    priceCache.set(key, { at: Date.now(), value });
    if (priceCache.size > 40) {
      const oldest = [...priceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) priceCache.delete(oldest[0]);
    }
  }
  return value;
}

/* ================================================================ 汇率 */

/**
 * USD/CNY 汇率。
 *
 * 源顺序刻意是「法币汇率源优先」：
 *   frankfurter（欧洲央行）→ er-api → CoinGecko 的 USDT 报价推导 → 兜底 7.1
 *
 * 早期版本把 CoinGecko 放第一位（用 USDT 报价反推），问题是 CoinGecko 一旦
 * 不可达，汇率就会掉到硬编码的 7.1 —— 数据文件里因此出现过
 * 「08:43 存 6.7045、20:22 又存 7.1」这种来回跳变。
 */
let fxCache = { at: 0, value: null, source: null };
const FX_TTL = 30 * 60 * 1000;

export async function fetchUsdCny(options = {}) {
  const { signal } = options;
  const sources = [
    [
      'frankfurter',
      async (sig) => {
        const d = await httpJson('https://api.frankfurter.app/latest?from=USD&to=CNY', { timeout: TIMEOUT, signal: sig });
        return d?.rates?.CNY;
      },
    ],
    [
      'er-api',
      async (sig) => {
        const d = await httpJson('https://open.er-api.com/v6/latest/USD', { timeout: TIMEOUT, signal: sig });
        return d?.rates?.CNY;
      },
    ],
    [
      'coingecko',
      async (sig) => {
        const d = await httpJson(`${CG_BASE}/simple/price?ids=tether&vs_currencies=cny,usd`, { timeout: TIMEOUT, signal: sig });
        const t = d?.tether;
        if (t?.cny && t?.usd) return Number(t.cny) / Number(t.usd);
        return null;
      },
    ],
  ];

  for (const [key, run] of sources) {
    throwIfAborted(signal);
    if (isDown(key)) continue;
    try {
      const v = await fromSource(key, () => run(signal), signal);
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        fxCache = { at: Date.now(), value: Number(n.toFixed(4)), source: key };
        return fxCache.value;
      }
      markFail(key, new Error('汇率返回非法值'));
    } catch (err) {
      if (aborted(err, signal)) throw err;
      /* 换下一个源 */
    }
  }
  // 全部失败：沿用上一次成功值；再没有就用既有约定兜底 7.1
  return fxCache.value ?? 7.1;
}

export async function getUsdCny(options = {}) {
  if (!options.fresh && fxCache.value && Date.now() - fxCache.at < FX_TTL) return fxCache.value;
  return fetchUsdCny(options);
}

/** 汇率来源（设置页展示用） */
export function fxStatus() {
  return { usdCny: fxCache.value, source: fxCache.source, at: fxCache.at ? new Date(fxCache.at).toISOString() : null };
}

/** 上一次成功取到的汇率（没有就用既有的兜底约定 7.1） */
export function lastUsdCny() {
  return fxCache.value ?? 7.1;
}

/* ============================================================ 历史日线 */

const CANDLE_SOURCES = [
  [
    'binance',
    async (p, days, signal) => {
      const limit = Math.min(Math.max(Math.ceil(days), 2), 500);
      // 稳定币没有「自己对自己」的交易对，统一用 USDC 计价（Binance 有此交易对）
      const sym = STABLE_QUOTES[p.base] ? `${p.base}USDC` : `${p.base}USDT`;
      const rows = await httpJson(
        `${BINANCE_BASES[0]}/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=1d&limit=${limit}`,
        { timeout: TIMEOUT_CANDLE, signal },
      );
      if (!Array.isArray(rows)) return [];
      return rows
        .map((r) => ({ ts: Number(r[0]), close: Number(r[4]) }))
        .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.close) && r.close > 0)
        .map((r) => ({ date: new Date(r.ts).toISOString().slice(0, 10), usd: r.close }));
    },
  ],
  [
    'gate',
    async (p, days, signal) => {
      const limit = Math.min(Math.max(Math.ceil(days), 2), 500);
      const sym = STABLE_QUOTES[p.base] ? `${p.base}_USDC` : `${p.base}_USDT`;
      const rows = await httpJson(
        `${GATE}/spot/candlesticks?currency_pair=${encodeURIComponent(sym)}&interval=1d&limit=${limit}`,
        { timeout: TIMEOUT_CANDLE, signal },
      );
      if (!Array.isArray(rows)) return [];
      // Gate 的列序：[时间(秒), 计价成交量, 收盘, 最高, 最低, 开盘, ...]
      return rows
        .map((r) => ({ ts: Number(r[0]) * 1000, close: Number(r[2]) }))
        .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.close) && r.close > 0)
        .map((r) => ({ date: new Date(r.ts).toISOString().slice(0, 10), usd: r.close }));
    },
  ],
  [
    'okx',
    async (p, days, signal) => {
      const limit = Math.min(Math.max(Math.ceil(days), 2), 100);
      const sym = STABLE_QUOTES[p.base] ? `${p.base}-USDC` : `${p.base}-USDT`;
      const rows = await httpJson(
        `${OKX}/market/candles?instId=${encodeURIComponent(sym)}&bar=1D&limit=${limit}`,
        { timeout: TIMEOUT_CANDLE, signal },
      );
      const list = rows?.data || [];
      // OKX 的列序：[时间(毫秒), 开, 高, 低, 收, ...]
      return list
        .map((r) => ({ ts: Number(r[0]), close: Number(r[4]) }))
        .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.close) && r.close > 0)
        .map((r) => ({ date: new Date(r.ts).toISOString().slice(0, 10), usd: r.close }));
    },
  ],
];

/**
 * 历史区间价格（用于「自上次更新以来」的涨跌基准）
 *
 * @param {string} coinId 币种标识
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate YYYY-MM-DD
 * @param {'cny'|'usd'} vsCurrency
 * @param {string} [symbolHint] 交易所符号
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Array<{date:string, price:number}>>} 按日裁剪，升序
 */
export async function priceHistory(coinId, fromDate, toDate, vsCurrency = 'cny', symbolHint, options = {}) {
  const { signal } = options;
  const from = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000) - 86400;
  const to = Math.floor(Date.parse(`${toDate}T23:59:59Z`) / 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const spanDays = Math.ceil((to - from) / 86400);
  const pair = { base: baseSymbolOf(coinId, symbolHint), pair: coinId };
  if (!pair.base) return [];

  for (const [key, run] of CANDLE_SOURCES) {
    throwIfAborted(signal);
    if (isDown(key)) continue;
    try {
      const candles = await fromSource(key, () => run(pair, spanDays + 5, signal), signal);
      const picked = candles
        .filter((c) => c.date >= fromDate && c.date <= toDate)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (!picked.length) {
        markFail(key, new Error('该源没有这段时间的日线'));
        continue;
      }
      const usdCny = vsCurrency === 'cny' ? await getUsdCny({ signal }) : null;
      return picked.map((c) => ({ date: c.date, price: vsCurrency === 'cny' ? round(c.usd * usdCny, 4) : c.usd }));
    } catch (err) {
      if (aborted(err, signal)) throw err;
      /* 换下一个源 */
    }
  }
  return [];
}

/* ============================================================== 币种搜索 */

/** 币种搜索：CoinGecko 优先（它能给出任意币的 id），失败时退回内置币种表 */
export async function searchCoins(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  try {
    const data = await fromSource('coingecko', () =>
      httpJson(`${CG_BASE}/search?query=${encodeURIComponent(q)}`, { timeout: TIMEOUT }),
    );
    return (data?.coins || []).slice(0, 15).map((c) => ({
      id: c.id,
      symbol: (c.symbol || '').toUpperCase(),
      name: c.name,
      rank: c.market_cap_rank ?? null,
      thumb: c.thumb ?? null,
    }));
  } catch {
    // CoinGecko 不可达时用内置表做本地匹配，至少热门币还能搜到
    const kw = q.toLowerCase();
    return COMMON_COINS.filter(
      (c) => c.id.includes(kw) || c.symbol.toLowerCase().includes(kw) || c.name.includes(q),
    ).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, rank: null, thumb: null }));
  }
}
