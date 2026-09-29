/**
 * 加密货币行情 Provider
 *
 * 选型说明（GitHub 生态调研结论）：
 *  - ccxt（https://github.com/ccxt/ccxt）：覆盖 100+ 交易所的完整交易/行情库，
 *    能力最强但体积大，且国内直连交易所域名经常被墙（实测 Binance 返回 451）。
 *  - CoinGecko 公开 REST（https://github.com/coingecko/coingecko-cli 同源数据）：
 *    无需 API Key、支持 CNY 计价与历史区间价格，最适合本地记账估值 → 本项目的**主源**。
 *  - OKX 公开 REST（https://www.okx.com/docs-v5/）：国内可直连，作为**备用源**做现价兜底。
 *  - CoinCap / Binance 备用源：Binance 在本网络被 451 拦截，故未启用。
 *
 * 设计要点：CoinGecko 免费额度有频率限制，因此所有请求走「串行 + 最小间隔 + TTL 缓存」。
 */

import { memo, round } from '../util.js';

const COINGECKO = 'https://api.coingecko.com/api/v3';
const OKX = 'https://www.okx.com/api/v5';
const UA = 'stockview/1.0 (local personal ledger)';

/* ------------------------------------------------------------ 请求限流器 */

let chain = Promise.resolve();
let lastCall = 0;
const MIN_INTERVAL = 2400; // ms，CoinGecko 免费档额度很小，宁可慢一点也不要 429

function throttle() {
  chain = chain.then(async () => {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
  });
  return chain;
}

async function requestJson(url, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 带退避重试的请求（429 / 5xx 才重试） */
async function requestJsonRetry(url, { attempts = 3, baseDelay = 3000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await requestJson(url);
    } catch (err) {
      lastErr = err;
      const retryable = err.status === 429 || (err.status >= 500 && err.status < 600) || err.name === 'AbortError';
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** i));
    }
  }
  throw lastErr;
}

async function cg(path, options) {
  await throttle();
  return requestJsonRetry(`${COINGECKO}${path}`, options);
}

/* ------------------------------------------------------------------ 搜索 */

/** 币种搜索：返回 CoinGecko 币种 id（后续估值都用 id） */
export async function searchCoins(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  try {
    const data = await cg(`/search?query=${encodeURIComponent(q)}`);
    return (data.coins || []).slice(0, 15).map((c) => ({
      id: c.id,
      symbol: (c.symbol || '').toUpperCase(),
      name: c.name,
      rank: c.market_cap_rank ?? null,
      thumb: c.thumb ?? null,
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ 行情 */

/** 批量现价（CNY / USD + 24h 涨跌）。带 60s 缓存。CoinGecko 失败时整体切 OKX 兜底。
 *  @param {string[]} ids CoinGecko 币种 id
 *  @param {Record<string,string>} [symbolMap] 币种 id → 交易所符号（OKX 兜底要用，如 bitcoin → BTC）
 */
export const getPrices = memo(async (ids, symbolMap = {}) => {
  const list = [...new Set((ids || []).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  try {
    const url = `/simple/price?ids=${encodeURIComponent(list.join(','))}&vs_currencies=cny,usd&include_24hr_change=true&include_last_updated_at=true`;
    const data = await cg(url);
    for (const [id, v] of Object.entries(data || {})) {
      out.set(id, {
        priceCny: Number(v.cny) || null,
        priceUsd: Number(v.usd) || null,
        change24h: Number(v.usd_24h_change) || null,
        lastUpdatedAt: v.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString() : null,
        source: 'coingecko',
      });
    }
  } catch {
    // CoinGecko 限流/超时：下面全部走 OKX
  }
  const missing = list.filter((id) => !out.has(id));
  for (const id of missing) {
    const okx = await getOkxPrice(id, symbolMap[id]);
    if (okx) out.set(id, okx);
  }
  return out;
}, 60_000);

/* --------------------------------------------------------------- OKX 兜底 */

/**
 * 把 CoinGecko 的币种 id（slug，如 `bitcoin`）解析成交易所符号（`BTC`）。
 *
 * ⚠️ 早期版本直接拿 id 大写去猜交易对（`BITCOIN-USDT`），OKX 上并不存在这种交易对，
 * 而且它返回的是 HTTP 200 + `code:"51001"` 空数据，不抛异常 —— 于是「备用源」静默失效。
 */
function okxBaseSymbol(coinId, symbolHint) {
  const hint = String(symbolHint || '').trim().toUpperCase();
  if (hint && /^[A-Z0-9]{2,12}$/.test(hint)) return hint;
  const known = COMMON_COINS.find((c) => c.id === String(coinId || '').toLowerCase());
  if (known) return known.symbol;
  return String(coinId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** OKX 现货现价（USDT 计价，USDT≈USD） */
async function getOkxPrice(coinId, symbolHint) {
  const base = okxBaseSymbol(coinId, symbolHint);
  if (!base) return null;
  for (const pair of [`${base}-USDT`, `${base}-USDC`]) {
    try {
      const data = await requestJson(`${OKX}/market/ticker?instId=${encodeURIComponent(pair)}`, { timeout: 8000 });
      const t = data?.data?.[0];
      if (!t?.last) continue;
      const usd = Number(t.last);
      const open24h = Number(t.open24h);
      const usdCny = (await getUsdCny()) || 7.1;
      return {
        priceUsd: usd,
        priceCny: round(usd * usdCny, 4),
        change24h: Number.isFinite(open24h) && open24h > 0 ? ((usd - open24h) / open24h) * 100 : null,
        lastUpdatedAt: t.ts ? new Date(Number(t.ts)).toISOString() : null,
        source: 'okx',
        pair,
      };
    } catch {
      /* 换下一个交易对 */
    }
  }
  return null;
}

/** OKX 日线（升序，含 CNY/USD 两种计价） */
async function okxCandles(coinId, days, symbolHint) {
  const base = okxBaseSymbol(coinId, symbolHint);
  if (!base) return [];
  const limit = Math.min(Math.max(Math.ceil(days), 2), 100);
  for (const pair of [`${base}-USDT`, `${base}-USDC`]) {
    try {
      const data = await requestJson(
        `${OKX}/market/candles?instId=${encodeURIComponent(pair)}&bar=1D&limit=${limit}`,
        { timeout: 10000 },
      );
      const rows = data?.data || [];
      if (!rows.length) continue;
      const usdCny = (await getUsdCny()) || 7.1;
      return rows
        .map((r) => ({ ts: Number(r[0]), close: Number(r[4]) }))
        .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.close) && r.close > 0)
        .map((r) => ({
          date: new Date(r.ts).toISOString().slice(0, 10),
          usd: r.close,
          cny: round(r.close * usdCny, 4),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      /* 换下一个交易对 */
    }
  }
  return [];
}

/** USD/CNY 汇率：CoinGecko（USDT 报价推导）→ frankfurter → er-api → 兜底 7.1 */
export const getUsdCny = memo(async () => {
  try {
    const data = await cg('/simple/price?ids=tether&vs_currencies=cny,usd');
    const t = data?.tether;
    if (t?.cny && t?.usd) return Number((t.cny / t.usd).toFixed(4));
  } catch {
    /* 下一个源 */
  }
  // OKX 没有 CNY 交易对，汇率只能走其它公开源
  for (const [url, pick] of [
    ['https://api.frankfurter.app/latest?from=USD&to=CNY', (d) => d?.rates?.CNY],
    ['https://open.er-api.com/v6/latest/USD', (d) => d?.rates?.CNY],
  ]) {
    try {
      const v = pick(await requestJson(url, { timeout: 8000 }));
      if (v) return Number(Number(v).toFixed(4));
    } catch {
      /* 下一个源 */
    }
  }
  return 7.1;
}, 30 * 60 * 1000);

/**
 * 历史区间价格（用于「自上次更新以来」的涨跌基准）
 * @param {string} coinId CoinGecko 币种 id
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate YYYY-MM-DD
 * @param {'cny'|'usd'} vsCurrency
 * @param {string} [symbolHint] 交易所符号（OKX 路径用）
 * @returns {Array<{date:string, price:number}>} 按日裁剪，升序
 */
export async function priceHistory(coinId, fromDate, toDate, vsCurrency = 'cny', symbolHint) {
  const from = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000) - 86400;
  const to = Math.floor(Date.parse(`${toDate}T23:59:59Z`) / 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const spanDays = Math.ceil((to - from) / 86400);

  // 短区间优先走 OKX 日线：无额度限制、响应快，不会撞 CoinGecko 的限流
  if (spanDays <= 45) {
    const candles = await okxCandles(coinId, spanDays + 5, symbolHint);
    const picked = candles.filter((c) => c.date >= fromDate && c.date <= toDate);
    if (picked.length) {
      return picked.map((c) => ({ date: c.date, price: vsCurrency === 'cny' ? c.cny : c.usd }));
    }
  }

  const data = await cg(
    `/coins/${encodeURIComponent(coinId)}/market_chart/range?vs_currency=${vsCurrency}&from=${from}&to=${to}`,
  );
  const points = data?.prices || [];
  // 每个自然日取最后一个点作为当日收盘价
  const byDay = new Map();
  for (const [ts, price] of points) {
    const d = new Date(ts).toISOString().slice(0, 10);
    byDay.set(d, Number(price));
  }
  return [...byDay.entries()].map(([date, price]) => ({ date, price })).sort((a, b) => a.date.localeCompare(b.date));
}

/* --------------------------------------------------------------- 常用币种 */

/** 内置热门币种，省去每次搜索 */
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
];
