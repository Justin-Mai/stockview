/**
 * 组合核心：资产增删改、估值计算、以及「更新引擎」。
 *
 * 更新引擎（对应需求 4）：
 *  - 股票：抓日线，用「上次更新时存下来的价格」作为基准，算出这段窗口的价格变化；
 *  - 基金：抓历史净值，先把 (上次定投日, 最新净值日] 之间的**每一个交易日**按当日净值
 *          把定投金额折算成份额补进去，再更新最新净值与变化；
 *  - 加密：抓现价，用上次更新的价格作为基准算变化（首次更新回补 7 日走势）。
 *  三者都以「上次更新的日期」为锚点，因此重复点击更新不会重复计算（幂等）。
 */

import * as cn from './providers/cn.js';
import * as crypto from './providers/crypto.js';
import { addDays, dayDiff, HISTORY_CAP, makeId, nowStamp, num, QTY_DP, round, today, toDateStr } from './util.js';

export const SCOPES = ['stock', 'fund', 'crypto'];
const SCOPE_LABEL = { stock: '股票', fund: '基金', crypto: '加密货币' };

/** 单只标的的行情回溯窗口（天），保证「上次更新」基准一定能取到 */
const LOOKBACK_DAYS = 30;
/** 首次配置定投时最多回溯的交易日数，避免误设起始日期导致巨量补算 */
const MAX_DCA_BACKFILL = 250;

/* ============================================================ 工具 */

function pushLog(state, entry) {
  state.logs.push({ id: makeId('log'), ts: nowStamp(), ...entry });
  if (state.logs.length > 600) state.logs = state.logs.slice(-600);
}

function normHistory(list, key) {
  const map = new Map();
  for (const it of list || []) {
    if (it && it.date) map.set(it.date, it);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-HISTORY_CAP);
}

function mergeHistory(existing, incoming, key) {
  const map = new Map();
  for (const it of existing || []) if (it?.date) map.set(it.date, it);
  for (const it of incoming || []) if (it?.date) map.set(it.date, it);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-HISTORY_CAP);
}

/* ============================================================ 资产增改删 */

function baseAsset(scope, data) {
  const quantity = round(num(data.quantity), QTY_DP);
  const costPrice = round(num(data.costPrice), 6);
  const costAmount =
    data.costAmount !== undefined && data.costAmount !== null && data.costAmount !== ''
      ? round(num(data.costAmount), 2)
      : round(quantity * costPrice, 2);
  return {
    id: makeId(scope),
    quantity,
    costAmount,
    costPrice,
    createdAt: nowStamp(),
    updatedAt: nowStamp(),
    note: data.note ? String(data.note) : '',
    /** 屏蔽：不计入任何合计，行仍在表里显示（标注提示） */
    hidden: Boolean(data.hidden),
    history: [],
    lastUpdate: null,
    baselinePrice: null,
    baselineDate: null,
  };
}

/**
 * 同一个代码允许存在多条 —— 例如同一只股票分别放在两个券商账户。
 * 因此「重复」的判定是 (代码 + 备注) 完全相同，而不是只看代码。
 * @param {string} codeKey 该板块的代码字段名（stock/fund 用 code，crypto 用 coinId）
 */
function findDuplicate(list, codeKey, code, note, excludeId = null) {
  return list.find(
    (x) =>
      x.id !== excludeId &&
      String(x[codeKey] ?? '') === code &&
      String(x.note ?? '').trim() === note,
  );
}

export function addAsset(state, scope, data = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`未知板块 ${scope}`);
  const code = String(data.code ?? '').trim();
  if (!code) throw new Error('代码不能为空');
  const name = String(data.name ?? '').trim() || code;
  const note = String(data.note ?? '').trim();
  const quantity = round(num(data.quantity), QTY_DP);
  if (quantity < 0) throw new Error('数量不能为负');
  const costPrice = round(num(data.costPrice), 6);
  const hidden = Boolean(data.hidden);

  if (scope === 'crypto') {
    const list = state.crypto;
    if (findDuplicate(list, 'coinId', code, note)) {
      throw new Error(`${name} 已有一条备注为「${note || '空'}」的记录；若放在不同账户，请在备注里填上账户名区分`);
    }
    const currency = data.currency === 'CNY' ? 'CNY' : 'USD';
    // 汇率兜底优先级：本次已取到的实时汇率 → 上次成功取到的汇率 → 7.1
    const usdCny = num(state.meta.usdCny, null) || crypto.lastUsdCny() || 7.1;
    const rate = currency === 'CNY' ? 1 : usdCny;
    const asset = {
      ...baseAsset(scope, data),
      coinId: code,
      symbol: String(data.symbol ?? '').trim().toUpperCase() || code.toUpperCase(),
      name,
      currency,
      hidden,
      costPrice,
      costAmount: round(quantity * costPrice * rate, 2),
      price: costPrice,
      priceCny: round(costPrice * rate, 6),
      priceUsd: currency === 'USD' ? costPrice : round(costPrice / (rate || 1), 6),
      change24h: null,
      updatedAt: nowStamp(),
    };
    list.push(asset);
    pushLog(state, { scope, kind: 'add', assetId: asset.id, text: `新增 ${SCOPE_LABEL[scope]} ${name}(${asset.symbol}) ${quantity} 份 @ ${costPrice} ${currency}` });
    return asset;
  }

  if (scope === 'stock') {
    const list = state.stocks;
    if (findDuplicate(list, 'code', code, note)) {
      throw new Error(`${name}(${code}) 已有一条备注为「${note || '空'}」的记录；若放在不同账户，请在备注里填上账户名区分`);
    }
    const asset = {
      ...baseAsset(scope, data),
      code,
      name,
      hidden,
      price: costPrice,
      priceDate: null,
      prevClose: null,
      changePercent: null,
      lastQuoteDate: null,
    };
    list.push(asset);
    pushLog(state, { scope, kind: 'add', assetId: asset.id, text: `新增股票 ${name}(${code}) ${quantity} 股 @ ${costPrice}` });
    return asset;
  }

  // fund
  const list = state.funds;
  if (findDuplicate(list, 'code', code, note)) {
    throw new Error(`${name}(${code}) 已有一条备注为「${note || '空'}」的记录；若放在不同账户，请在备注里填上账户名区分`);
  }
  const dca = {
    enabled: Boolean(data.dca?.enabled ?? data.dcaEnabled ?? false),
    amount: round(num(data.dca?.amount ?? data.dcaAmount), 2),
    frequency: 'daily',
    startDate: toDateStr(data.dca?.startDate ?? data.dcaStartDate) || today(),
  };
  const asset = {
    ...baseAsset(scope, data),
    code,
    name,
    hidden,
    nav: costPrice,
    navDate: null,
    accNav: null,
    dailyReturn: null,
    dca,
    lastDcaDate: null,
    dcaCount: 0,
    dcaInvested: 0,
    dcaUnits: 0,
    missedDates: [],
  };
  list.push(asset);
  pushLog(state, { scope, kind: 'add', assetId: asset.id, text: `新增基金 ${name}(${code}) 持有 ${quantity} 份 @ ${costPrice}${dca.enabled ? `，开启日定投 ¥${dca.amount}` : ''}` });
  return asset;
}

const FUND_EDITABLE = ['name', 'quantity', 'costAmount', 'costPrice', 'note'];
const STOCK_EDITABLE = ['name', 'quantity', 'costAmount', 'costPrice', 'note'];
const CRYPTO_EDITABLE = ['name', 'symbol', 'quantity', 'costAmount', 'costPrice', 'currency', 'note'];

/**
 * 代码变更是「换了一只标的」，所有跟着旧标的走的行情状态都必须清掉 ——
 * 否则会出现「名字是 B、市价还是 A」这种静默错数据。
 * 数量 / 成本 / 备注 / 定投配置保留（多数情况是在改代码笔误，不该把持仓也清掉）。
 */
function resetQuoteState(asset, scope, state) {
  asset.history = [];
  asset.lastUpdate = null;
  asset.baselinePrice = null;
  asset.baselineDate = null;

  if (scope === 'stock') {
    asset.price = asset.costPrice; // 先占位，紧接着 primeAsset 会取真实行情
    asset.priceDate = null;
    asset.prevClose = null;
    asset.changePercent = null;
    asset.lastQuoteDate = null;
  } else if (scope === 'fund') {
    asset.nav = asset.costPrice;
    asset.navDate = null;
    asset.accNav = null;
    asset.dailyReturn = null;
  } else {
    const usdCny = num(state.meta.usdCny, null) || crypto.lastUsdCny() || 7.1;
    const rate = asset.currency === 'CNY' ? 1 : usdCny;
    asset.price = asset.costPrice;
    asset.priceCny = round(asset.costPrice * rate, 6);
    asset.priceUsd = asset.currency === 'USD' ? asset.costPrice : round(asset.costPrice / (rate || 1), 6);
    asset.change24h = null;
    asset.priceSource = null;
  }
}

/**
 * 修改资产。
 * @returns {{asset: object, codeChanged: boolean}} codeChanged 为真时调用方需要重新取行情
 */
export function updateAsset(state, scope, id, data = {}) {
  const list = state[scope === 'stock' ? 'stocks' : scope === 'fund' ? 'funds' : 'crypto'];
  if (!list) throw new Error(`未知板块 ${scope}`);
  const asset = list.find((x) => x.id === id);
  if (!asset) throw new Error('未找到该资产');

  const before = { quantity: asset.quantity, costAmount: asset.costAmount };
  const fields = scope === 'crypto' ? CRYPTO_EDITABLE : scope === 'fund' ? FUND_EDITABLE : STOCK_EDITABLE;
  for (const key of fields) {
    if (data[key] === undefined) continue;
    if (key === 'quantity') asset.quantity = round(num(data.quantity), QTY_DP);
    else if (key === 'costAmount') asset.costAmount = round(num(data.costAmount), 2);
    else if (key === 'costPrice') asset.costPrice = round(num(data.costPrice), 6);
    else asset[key] = String(data[key] ?? '').trim();
  }

  /* ------------------------------ 代码变更 ------------------------------ */
  // 加密货币的字段叫 coinId，但新增接口用的是 code，这里两者都认
  const codeKey = scope === 'crypto' ? 'coinId' : 'code';
  const incomingCode = scope === 'crypto' ? (data.coinId ?? data.code) : data.code;
  const oldCode = asset[codeKey];
  let codeChanged = false;

  if (incomingCode !== undefined && incomingCode !== null && String(incomingCode).trim() !== '') {
    const nextCode = String(incomingCode).trim();
    if (nextCode !== oldCode) {
      // 同代码允许多条（不同账户），因此按「代码 + 备注」判重
      if (findDuplicate(list, codeKey, nextCode, String(asset.note ?? '').trim(), id)) {
        throw new Error(`${nextCode} 已有一条相同备注的记录；若放在不同账户，请在备注里区分`);
      }
      asset[codeKey] = nextCode;
      codeChanged = true;
    }
  }

  /* ------------------------------ 成本口径 ------------------------------ */
  // 三条规则，目的是让「数量 / 成本价 / 总成本」三者永远不会悄悄脱节：
  //   股票   —— 界面没有单独的总成本输入，所以 数量×成本价 就是唯一口径，任一变动都重算；
  //   基金   —— 总成本是定投累加出来的权威值：显式改成本价才重算，只改份额则保留总成本但同步均价；
  //   加密货币 —— 改数量/成本价/币种都重算。
  //   recalcCost 是给历史脏数据用的一次性修复开关。
  const usdCny = num(state.meta.usdCny, null) || crypto.lastUsdCny() || 7.1;
  const rate = asset.currency === 'CNY' ? 1 : usdCny;
  const costFromPrice = () => round(asset.quantity * (scope === 'crypto' ? asset.costPrice * rate : asset.costPrice), 2);
  const explicitCost = data.costAmount !== undefined;

  if (data.recalcCost || (scope === 'stock' && (data.quantity !== undefined || data.costPrice !== undefined))) {
    asset.costAmount = costFromPrice();
  } else if (!explicitCost && data.costPrice !== undefined) {
    asset.costAmount = costFromPrice();
  } else if (!explicitCost && scope === 'crypto' && (data.quantity !== undefined || data.currency !== undefined)) {
    asset.costAmount = costFromPrice();
  } else if (!explicitCost && scope === 'fund' && data.quantity !== undefined) {
    // 只改份额：保留总成本（视为份额笔误修正），把成本价同步成新的均价
    asset.costPrice = asset.quantity > 0 ? round(asset.costAmount / asset.quantity, 6) : asset.costPrice;
  }

  if (scope === 'crypto' && data.currency !== undefined) asset.currency = data.currency === 'CNY' ? 'CNY' : 'USD';

  // 屏蔽开关：只翻转 hidden，行情与成本字段一律原样保留（见 setAssetHidden 的说明）
  if (data.hidden !== undefined) {
    if (Boolean(data.hidden)) setAssetHidden(state, scope, id, true);
    else if (asset.hidden) setAssetHidden(state, scope, id, false);
  }

  if (scope === 'fund' && data.dca) {
    asset.dca = { ...asset.dca };
    if (data.dca.enabled !== undefined) asset.dca.enabled = Boolean(data.dca.enabled);
    if (data.dca.amount !== undefined) asset.dca.amount = round(num(data.dca.amount), 2);
    if (data.dca.startDate !== undefined) asset.dca.startDate = toDateStr(data.dca.startDate) || asset.dca.startDate;
    if (data.dca.frequency !== undefined) asset.dca.frequency = 'daily';
  }
  if (scope === 'fund' && data.resetDca) {
    asset.lastDcaDate = null;
    asset.missedDates = [];
    asset.dcaCount = 0;
    asset.dcaInvested = 0;
    asset.dcaUnits = 0;
  }

  // 放在最后：前面可能刚改过 costPrice，占位价要用最新的成本价
  if (codeChanged) resetQuoteState(asset, scope, state);

  asset.updatedAt = nowStamp();
  pushLog(state, {
    scope,
    kind: 'edit',
    assetId: asset.id,
    text:
      `修改 ${asset.name}：持仓 ${before.quantity} → ${asset.quantity}，总成本 ¥${before.costAmount} → ¥${asset.costAmount}` +
      (codeChanged ? `，代码 ${oldCode} → ${asset[codeKey]}（已清空旧的行情状态并重新取价）` : '') +
      (scope === 'fund' ? `，日定投 ${asset.dca.enabled ? '¥' + asset.dca.amount : '关闭'}` : ''),
  });
  return { asset, codeChanged };
}

/**
 * 重排某个板块的顺序（界面上拖动排序后保存）。
 * 只接受合法 id；未出现在 ids 里的记录按原顺序追加到末尾，避免并发新增导致丢数据。
 */
export function reorderAssets(state, scope, ids = []) {
  const key = scopeKey(scope);
  const list = state[key];
  const byId = new Map(list.map((x) => [x.id, x]));
  const next = [];
  for (const id of ids) {
    const asset = byId.get(id);
    if (asset) {
      next.push(asset);
      byId.delete(id);
    }
  }
  for (const asset of list) {
    if (byId.has(asset.id)) next.push(asset);
  }
  state[key] = next;
  return next.length;
}

/* ---------------------------------------------------------------- 屏蔽 */

/**
 * 屏蔽 = 「这一项暂时不计入任何合计」，**不是**删除、也不是清空数据。
 *
 * 关键：屏蔽只改「算不算进合计」，不改「更不更新」——
 *  - 成本价 / 数量 / 总成本 / 备注 / 定投配置全部原样保留；
 *  - 行情**照常更新**：价格、走势、上次更新日都会跟着走，基金的定投也照常补算。
 *    （早期版本屏蔽后会跳过更新，取消屏蔽时看到的是屏蔽那天的旧价，
 *     还得手动补一次；现在屏蔽项与普通项走完全相同的更新流程。）
 *  - 界面上照样显示真实数字（标注成「已屏蔽」），这样你一眼能看出这一项现在值多少，
 *    只是它没算进合计；
 *  - 取消屏蔽 = 把 hidden 放回 false，**所有数字立刻回到组合里**，不需要再做别的。
 *
 * ⚠️ 更早的版本在屏蔽时把这些行情字段清成 null，结果取消屏蔽后成本价 /
 * 均价都变成 0，必须再点一次「更新行情」才能找回来 —— 用户的反馈是
 * 「屏蔽了之后把成本价搞没了」。屏蔽不该有任何破坏性。
 */
const QUOTE_FIELDS = {
  stock: ['price', 'priceDate', 'prevClose', 'changePercent', 'lastQuoteDate', 'baselinePrice', 'baselineDate', 'lastUpdate', 'history'],
  fund: ['nav', 'navDate', 'accNav', 'dailyReturn', 'baselinePrice', 'baselineDate', 'lastUpdate', 'history'],
  crypto: ['price', 'priceCny', 'priceUsd', 'change24h', 'priceSource', 'baselinePrice', 'baselineDate', 'lastUpdate', 'history'],
};

/** 该标的当前是否「有行情」——仅用于日志里说明「带着哪一天的行情进入屏蔽」 */
const QUOTE_PROBE = {
  stock: ['price'],
  fund: ['nav'],
  crypto: ['priceUsd', 'priceCny'],
};

function hasQuote(scope, asset) {
  return (QUOTE_PROBE[scope] || []).some((f) => num(asset[f], 0) > 0);
}

function scopeKey(scope) {
  const key = scope === 'stock' ? 'stocks' : scope === 'fund' ? 'funds' : scope === 'crypto' ? 'crypto' : null;
  if (!key) throw new Error(`未知板块 ${scope}`);
  return key;
}

/** 设置（或取消）屏蔽。行情与成本字段一律原样保留，只翻转 hidden。 */
export function setAssetHidden(state, scope, id, hidden) {
  const asset = state[scopeKey(scope)].find((x) => x.id === id);
  if (!asset) throw new Error('未找到该资产');
  const next = hidden !== false;
  if (Boolean(asset.hidden) === next) return asset;

  const quoteDate = next && hasQuote(scope, asset) ? asset.lastUpdate || null : null;
  asset.hidden = next;
  // 这里**没有**任何字段被清空 —— 详见上面 QUOTE_FIELDS 处的说明
  asset.updatedAt = nowStamp();
  pushLog(state, {
    scope,
    kind: 'edit',
    assetId: asset.id,
    text: next
      ? `屏蔽 ${asset.name}${asset.code ? `(${asset.code})` : ''}：不再计入合计，记录与行情原样保留` +
        `${quoteDate ? `（当前行情 ${quoteDate}，之后照常更新）` : ''}`
      : `取消屏蔽 ${asset.name}${asset.code ? `(${asset.code})` : ''}：已恢复计入合计`,
  });
  return asset;
}

export function deleteAsset(state, scope, id) {
  const key = scopeKey(scope);
  const idx = state[key].findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('未找到该资产');
  const [asset] = state[key].splice(idx, 1);
  pushLog(state, { scope, kind: 'delete', assetId: id, text: `删除 ${asset.name}${asset.code ? `(${asset.code})` : ''}` });
  return asset;
}

/* ============================================================ 更新引擎 */

/**
 * 新增资产后立刻取一次行情，让新记录马上显示真实市值（而不是成本价占位）。
 * 刻意**不**设置 lastUpdate，这样首次点「更新」时仍会以「上一交易日 / 近 7 日」为基准。
 */
export async function primeAsset(state, scope, asset) {
  try {
    if (scope === 'stock') {
      const map = await cn.stockQuotes([asset.code]);
      const q = map.get(asset.code) || [...map.values()][0];
      if (q) {
        asset.price = q.price;
        asset.priceDate = today();
        asset.changePercent = q.changePercent;
      }
    } else if (scope === 'fund') {
      const map = await cn.fundQuotes([asset.code]);
      const q = map.get(asset.code);
      if (q) {
        asset.nav = q.nav;
        asset.accNav = q.accNav;
        asset.navDate = q.navDate;
        // 上游该字段为「日增长率(%)」，与 navHistory 的 dailyReturn 同义
        asset.dailyReturn = q.change;
      }
    } else {
      // 汇率必须先落库：加密货币的成本要用它折算，而 addAsset 里的兜底值是硬编码的 7.1，
      // 一旦 meta.usdCny 为空，成本就会被算错好几个百分点（且因为成本是入库冻结值，错误会一直留着）
      try {
        const rate = await crypto.getUsdCny();
        if (rate) {
          state.meta.usdCny = rate;
          state.meta.usdCnyAt = nowStamp();
        }
      } catch {
        /* 拿不到就沿用已有汇率 */
      }
      const usdCny = num(state.meta.usdCny, null) || crypto.lastUsdCny() || 7.1;
      const map = await crypto.getPrices([asset.coinId], { [asset.coinId]: asset.symbol });
      const p = map.get(asset.coinId);
      if (p?.priceUsd) {
        // 交易所源只给美元价，人民币一律按当次汇率折算，避免两个源口径打架
        asset.priceUsd = p.priceUsd;
        asset.priceCny = round(p.priceUsd * usdCny, 6);
        asset.price = asset.currency === 'CNY' ? asset.priceCny : asset.priceUsd;
        asset.change24h = p.change24h;
        asset.priceSource = p.source;
      }
    }
  } catch {
    // 拿不到就沿用成本价占位，用户点「更新」时会再试一次
  }
  return asset;
}

/** 统计某板块的资产数量（用于给进度条算总步数） */
export function countAssets(state, scope) {
  if (scope === 'stock') return state.stocks.length;
  if (scope === 'fund') return state.funds.length;
  if (scope === 'crypto') return state.crypto.length;
  return 0;
}

/**
 * 让一个**不可取消**的 Promise 变得可以提前放弃。
 *
 * stock-sdk / 行情源不接受 AbortSignal，所以正在飞的那个请求没法真的掐断
 * （它会在后台自己跑完，结果被丢弃）。但「中止更新」没必要等它：
 * 用 race 让调用方立刻得到 AbortError 返回，用户就不用盯着遮罩干等
 * —— 实测行情源偶发重试时，单个请求能挂 10 秒以上。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function abortable(promise, signal) {
  if (!signal) return promise;
  crypto.throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(crypto.abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 执行一次更新。
 * @param {object} state
 * @param {'stock'|'fund'|'crypto'} scope
 * @param {{onProgress?: (p:{label?:string, advance?:boolean}) => void, signal?: AbortSignal}} [options]
 *        onProgress 会在每只标的开始前报一次 label，完成后带 advance:true 报一次，供长任务进度条使用
 *        signal 用于「中止更新」：三个板块都可中断 ——
 *        每只标的开工前、以及每个行情源的循环里都会检查，命中时抛 AbortError，
 *        调用方据此**不落盘、不推进 lastUpdate**。
 * @returns {Promise<{scope:string, summary:object, items:Array, errors:Array}>}
 */
export async function runUpdate(state, scope, options = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`未知板块 ${scope}`);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal;
  const startedAt = nowStamp();
  const report = { scope, startedAt, finishedAt: null, summary: {}, items: [], errors: [] };

  // 同一代码可能有多条持仓（不同账户），行情/净值只抓一次，避免把更新时间乘以账户数
  const fetched = new Map();
  const once = async (key, fn) => {
    crypto.throwIfAborted(signal);
    if (!fetched.has(key)) fetched.set(key, await abortable(fn(), signal));
    return fetched.get(key);
  };

  if (scope === 'stock') await updateStocks(state, report, progress, once, { signal });
  else if (scope === 'fund') await updateFunds(state, report, progress, once, { signal });
  else await updateCryptos(state, report, progress, options);

  // 中途被中止：**不推进** lastUpdate / quoteAt，也不写这条 update 流水 ——
  // 下次更新仍以原来的基准计算，不会算漏一段行情。
  crypto.throwIfAborted(signal);

  state.meta.lastUpdate[scope] = today();
  state.meta.quoteAt = nowStamp();
  report.finishedAt = nowStamp();
  report.summary.label = SCOPE_LABEL[scope];
  report.summary.updated = report.items.filter((x) => !x.error).length;
  report.summary.failed = report.errors.length;
  report.summary.hidden = report.hiddenCount || 0;
  return report;
}

/* --------------------------------------------------------------- 股票 */

async function updateStocks(state, report, progress = () => {}, once = async (_k, fn) => fn(), options = {}) {
  const { signal } = options;
  const list = state.stocks;
  if (!list.length) {
    report.summary.message = '股票列表为空，没有需要更新的持仓';
    return;
  }
  const t = today();
  let totalChange = 0;
  let totalValue = 0;

  for (const stock of list) {
    // 每只标的开工前先看一眼中止信号：否则点了「停止更新」也要把剩下的股票全部跑完
    crypto.throwIfAborted(signal);
    // 屏蔽的标的**照常更新**：屏蔽只影响合计口径，不影响是否取价。
    // 这里只额外记一笔，供界面提示「其中 N 项已屏蔽」。
    if (stock.hidden) report.hiddenCount = (report.hiddenCount || 0) + 1;
    const item = { id: stock.id, code: stock.code, name: stock.name };
    progress({ label: `正在获取 ${stock.name}（${stock.code}）日线…` });
    try {
      const from = stock.lastUpdate ? addDays(stock.lastUpdate, -LOOKBACK_DAYS) : addDays(t, -LOOKBACK_DAYS);
      // 缓存键带上起始日期：不同账户的上次更新日不同、需要的窗口也不同，不能混用
      const bars = await once(`kline:${stock.code}:${from}`, () => cn.dailyKline(stock.code, { start: from, end: t }));
      if (!bars.length) throw new Error('未取到日线数据');
      const last = bars[bars.length - 1];
      const prevBar = bars.length > 1 ? bars[bars.length - 2] : null;

      const oldPrice = num(stock.price, null);
      const oldDate = stock.lastUpdate;

      // 基准：优先用「上次更新时存下来的价格」，首次更新则用上一交易日收盘
      if (oldPrice && Number.isFinite(oldPrice) && oldPrice > 0 && oldDate) {
        stock.baselinePrice = oldPrice;
        stock.baselineDate = oldDate;
      } else if (prevBar) {
        stock.baselinePrice = prevBar.close;
        stock.baselineDate = prevBar.date;
      } else {
        stock.baselinePrice = last.close;
        stock.baselineDate = last.date;
      }

      stock.price = last.close;
      stock.priceDate = last.date;
      stock.lastQuoteDate = last.date;
      stock.prevClose = prevBar ? prevBar.close : last.open ?? null;
      stock.changePercent = last.changePercent ?? null;
      stock.lastUpdate = t;
      stock.history = mergeHistory(
        stock.history,
        bars.map((b) => ({ date: b.date, close: b.close })),
      );

      const change = stock.price - stock.baselinePrice;
      const changePct = stock.baselinePrice ? (change / stock.baselinePrice) * 100 : 0;
      const tradingDays = stock.baselineDate
        ? (await cn.tradingDaysBetween(stock.baselineDate, last.date)).length
        : 0;

      Object.assign(item, {
        price: stock.price,
        priceDate: stock.priceDate,
        changePercent: stock.changePercent,
        baselinePrice: stock.baselinePrice,
        baselineDate: stock.baselineDate,
        change: round(change, 4),
        changePct: round(changePct, 2),
        days: Math.max(tradingDays, 0),
        marketValue: round(stock.quantity * stock.price, 2),
      });
      totalChange += stock.quantity * change;
      totalValue += stock.quantity * stock.price;
      report.items.push(item);
    } catch (err) {
      // 中止不是「这一只取价失败」：原样抛出去，让整轮更新立刻结束
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      item.error = err.message || String(err);
      // 只有在该标的此前成功取过行情时才推进日期；
      // 否则（比如代码写错）保持 lastUpdate 为空，修好后首次更新仍会用「上一交易日」作基准
      if (stock.lastQuoteDate) stock.lastUpdate = t;
      report.items.push(item);
      report.errors.push({ id: stock.id, code: stock.code, name: stock.name, message: item.error });
    }
    progress({ advance: true });
  }

  pushLog(state, {
    scope: 'stock',
    kind: 'update',
    text: `更新股票行情：成功 ${report.items.filter((i) => !i.error).length}/${list.length} 只，价格贡献 ${totalChange >= 0 ? '+' : ''}¥${round(totalChange, 2)}`,
  });
  report.summary.totalChange = round(totalChange, 2);
  report.summary.totalValue = round(totalValue, 2);
}

/* --------------------------------------------------------------- 基金 */

async function updateFunds(state, report, progress = () => {}, once = async (_k, fn) => fn(), options = {}) {
  const { signal } = options;
  const list = state.funds;
  if (!list.length) {
    report.summary.message = '基金列表为空，没有需要更新的持仓';
    return;
  }
  let totalChange = 0;
  let dcaAmount = 0;
  let dcaUnits = 0;
  let dcaApplied = 0;

  for (const fund of list) {
    // 每只基金开工前先看中止信号（见 updateStocks 里的说明）
    crypto.throwIfAborted(signal);
    // 屏蔽的基金**照常取净值、照常补算定投**（屏蔽只影响合计口径）
    if (fund.hidden) report.hiddenCount = (report.hiddenCount || 0) + 1;
    const item = { id: fund.id, code: fund.code, name: fund.name };
    progress({ label: `正在获取 ${fund.name}（${fund.code}）历史净值…` });
    try {
      const hist = await once(`nav:${fund.code}`, () => cn.fundNavHistory(fund.code));
      const navMap = new Map();
      for (const it of hist.items) if (it.nav !== null && it.nav > 0) navMap.set(it.date, it.nav);
      if (!navMap.size) throw new Error('未取到历史净值');

      const dates = [...navMap.keys()].sort();
      const lastNavDate = dates[dates.length - 1];
      const prevNavDate = dates.length > 1 ? dates[dates.length - 2] : null;

      const oldNav = num(fund.nav, null);
      const oldDate = fund.lastUpdate;
      if (oldNav && Number.isFinite(oldNav) && oldNav > 0 && oldDate) {
        fund.baselinePrice = oldNav;
        fund.baselineDate = oldDate;
      } else if (prevNavDate) {
        fund.baselinePrice = navMap.get(prevNavDate);
        fund.baselineDate = prevNavDate;
      } else {
        fund.baselinePrice = navMap.get(lastNavDate);
        fund.baselineDate = lastNavDate;
      }

      const unitsBefore = fund.quantity;
      const costBefore = fund.costAmount;

      /* ---------------- 定投补算：逐交易日把金额折算成份额 ---------------- */
      const dca = fund.dca || { enabled: false, amount: 0, frequency: 'daily', startDate: today() };
      const dailyAmount = num(dca.amount);
      const dcaInfo = { enabled: Boolean(dca.enabled), dailyAmount, applied: 0, units: 0, invested: 0, dates: [], skipped: [], pending: 0 };

      if (dcaInfo.enabled && dailyAmount > 0) {
        const startDate = dca.startDate || fund.createdAt?.slice(0, 10) || today();
        const anchor = fund.lastDcaDate ? fund.lastDcaDate : addDays(startDate, -1);
        const missed = new Set(fund.missedDates || []);
        // 只补「已经有净值的交易日」；今天净值还没公布的会留到下次更新再补
        const candidates = (await cn.tradingDaysBetween(anchor, lastNavDate, MAX_DCA_BACKFILL)).filter(
          (d) => d >= startDate && !missed.has(d),
        );
        for (const d of candidates) {
          const nav = navMap.get(d);
          if (!nav || !(nav > 0)) {
            // 该交易日基金没有公布净值（暂停申赎 / 新基金建仓期），记为已跳过，避免反复重试
            missed.add(d);
            dcaInfo.skipped.push(d);
            continue;
          }
          const units = dailyAmount / nav;
          fund.quantity = round(fund.quantity + units, QTY_DP);
          fund.costAmount = round(fund.costAmount + dailyAmount, 2);
          fund.dcaCount = num(fund.dcaCount) + 1;
          fund.dcaInvested = round(num(fund.dcaInvested) + dailyAmount, 2);
          fund.dcaUnits = round(num(fund.dcaUnits) + units, QTY_DP);
          fund.lastDcaDate = d;
          dcaInfo.applied += 1;
          dcaInfo.units += units;
          dcaInfo.invested = round(dcaInfo.invested + dailyAmount, 2);
          dcaInfo.dates.push({ date: d, nav, units: round(units, 4), amount: dailyAmount });
          // 单日补算笔数过多时（首次配置定投）只记汇总，避免日志刷屏
          if (candidates.length <= 12) {
            pushLog(state, {
              scope: 'fund',
              kind: 'dca',
              assetId: fund.id,
              date: d,
              text: `定投 ${fund.name}(${fund.code}) ${d}：¥${dailyAmount} ÷ 净值 ${nav} = +${round(units, 4)} 份`,
            });
          }
        }
        if (candidates.length > 12) {
          pushLog(state, {
            scope: 'fund',
            kind: 'dca',
            assetId: fund.id,
            text: `定投 ${fund.name}(${fund.code}) 一次性补算 ${dcaInfo.applied} 个交易日：共投入 ¥${dcaInfo.invested}，折算 +${round(dcaInfo.units, 4)} 份`,
          });
        }
        fund.missedDates = [...missed].sort().slice(-60);
        // 最新净值日之后到今天的交易日还在等净值公布
        dcaInfo.pending = (await cn.tradingDaysBetween(fund.lastDcaDate || anchor, today())).filter((d) => d >= startDate).length;
      }

      fund.nav = navMap.get(lastNavDate);
      fund.navDate = lastNavDate;
      fund.accNav = hist.items.find((it) => it.date === lastNavDate)?.accNav ?? fund.accNav ?? null;
      fund.dailyReturn = hist.items.find((it) => it.date === lastNavDate)?.dailyReturn ?? null;
      fund.lastUpdate = today();
      fund.history = mergeHistory(
        fund.history,
        hist.items.filter((it) => it.nav !== null).map((it) => ({ date: it.date, nav: it.nav })),
      );

      const change = fund.nav - fund.baselinePrice;
      const changePct = fund.baselinePrice ? (change / fund.baselinePrice) * 100 : 0;
      const tradingDays = fund.baselineDate ? (await cn.tradingDaysBetween(fund.baselineDate, lastNavDate)).length : 0;

      dcaAmount += dcaInfo.invested;
      dcaUnits += dcaInfo.units;
      dcaApplied += dcaInfo.applied;
      totalChange += unitsBefore * change;

      Object.assign(item, {
        nav: fund.nav,
        navDate: fund.navDate,
        changePercent: fund.dailyReturn,
        baselinePrice: fund.baselinePrice,
        baselineDate: fund.baselineDate,
        change: round(change, 4),
        changePct: round(changePct, 2),
        days: Math.max(tradingDays, 0),
        unitsBefore,
        unitsAfter: fund.quantity,
        costBefore,
        costAfter: fund.costAmount,
        dca: dcaInfo,
        marketValue: round(fund.quantity * fund.nav, 2),
      });
      report.items.push(item);
    } catch (err) {
      // 中止不是「这一只取净值失败」：原样抛出去，让整轮更新立刻结束
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      item.error = err.message || String(err);
      if (fund.navDate) fund.lastUpdate = today();
      report.items.push(item);
      report.errors.push({ id: fund.id, code: fund.code, name: fund.name, message: item.error });
    }
    progress({ advance: true });
  }

  pushLog(state, {
    scope: 'fund',
    kind: 'update',
    text: `更新基金净值：成功 ${report.items.filter((i) => !i.error).length}/${list.length} 只；补算定投 ${dcaApplied} 笔、¥${round(dcaAmount, 2)}，折算 ${round(dcaUnits, 4)} 份`,
  });
  report.summary.totalChange = round(totalChange, 2);
  report.summary.dca = { applied: dcaApplied, amount: round(dcaAmount, 2), units: round(dcaUnits, 4) };
}

/* ----------------------------------------------------------- 加密货币 */

async function updateCryptos(state, report, progress = () => {}, options = {}) {
  const { signal } = options;
  const list = state.crypto;
  if (!list.length) {
    report.summary.message = '加密货币列表为空，没有需要更新的持仓';
    return;
  }
  const t = today();
  let totalChange = 0;

  progress({ label: '正在获取 USD/CNY 汇率…' });
  // 汇率先刷新一次，供成本/市值折算
  try {
    const rate = await crypto.getUsdCny({ signal });
    if (rate) {
      state.meta.usdCny = rate;
      state.meta.usdCnyAt = nowStamp();
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    /* 沿用旧汇率 */
  }
  const usdCny = num(state.meta.usdCny, null) || crypto.lastUsdCny() || 7.1;

  const symbols = Object.fromEntries(list.map((x) => [x.coinId, x.symbol]).filter(([, s]) => s));
  progress({ label: `正在获取 ${list.length} 个币种的现价…` });
  // 一次拿到全部现价（Binance / Gate.io 都支持批量），拿不到的会在下面按币种报错
  const prices = await crypto.getPrices(
    list.map((x) => x.coinId),
    symbols,
    { signal },
  );
  const failedSource = crypto.sourceStatus().filter((s) => s.cooling);

  for (const coin of list) {
    // 每个币开工前先看中止信号（见 updateStocks 里的说明）
    crypto.throwIfAborted(signal);
    // 屏蔽的币种**照常取价**（屏蔽只影响合计口径）
    if (coin.hidden) report.hiddenCount = (report.hiddenCount || 0) + 1;
    const item = { id: coin.id, coinId: coin.coinId, name: coin.name, symbol: coin.symbol };
    try {
      const p = prices.get(coin.coinId);
      if (!p || !(p.priceUsd > 0)) throw new Error('未取到价格（Binance / Gate / OKX / CoinGecko 均无返回）');

      const oldPrice = num(coin.price, null);
      const oldDate = coin.lastUpdate;
      if (oldPrice && oldPrice > 0 && oldDate) {
        coin.baselinePrice = oldPrice;
        coin.baselineDate = oldDate;
      } else {
        // 首次更新：回补最近 7 天的走势，用最早一天作为基准
        try {
          const hist = await crypto.priceHistory(
            coin.coinId,
            addDays(t, -7),
            t,
            coin.currency === 'CNY' ? 'cny' : 'usd',
            coin.symbol,
            { signal },
          );
          if (hist.length) {
            coin.baselinePrice = hist[0].price;
            coin.baselineDate = hist[0].date;
            coin.history = mergeHistory(coin.history, hist.map((h) => ({ date: h.date, price: h.price })));
          }
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw err;
          /* 忽略：不影响现价更新 */
        }
      }

      // 交易所源只报美元价，人民币按当次汇率折算，保证与「成本口径」用的是同一个汇率
      coin.priceUsd = p.priceUsd;
      coin.priceCny = round(p.priceUsd * usdCny, 6);
      coin.change24h = p.change24h;
      coin.price = coin.currency === 'CNY' ? coin.priceCny : coin.priceUsd;
      coin.priceSource = p.source;
      coin.lastUpdate = t;
      coin.history = mergeHistory(coin.history, [{ date: t, price: coin.price }]);

      const change = coin.price != null && coin.baselinePrice ? coin.price - coin.baselinePrice : 0;
      const changePct = coin.baselinePrice ? (change / coin.baselinePrice) * 100 : 0;
      totalChange += coin.quantity * change * (coin.currency === 'CNY' ? 1 : usdCny);

      Object.assign(item, {
        price: coin.price,
        priceCny: coin.priceCny,
        priceUsd: coin.priceUsd,
        currency: coin.currency,
        change24h: coin.change24h,
        baselinePrice: coin.baselinePrice,
        baselineDate: coin.baselineDate,
        change: round(change, 6),
        changePct: round(changePct, 2),
        days: coin.baselineDate ? dayDiff(t, coin.baselineDate) : 0,
        marketValue: round(coin.quantity * coin.priceCny, 2),
        source: p.source,
      });
      report.items.push(item);
      progress({ label: `${coin.name}（${coin.symbol || coin.coinId}）${p.source} ✓`, advance: true });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      item.error = err.message || String(err);
      if (coin.baselinePrice) coin.lastUpdate = t;
      report.items.push(item);
      report.errors.push({ id: coin.id, coinId: coin.coinId, name: coin.name, message: item.error });
      progress({ advance: true });
    }
  }

  const okCount = report.items.filter((i) => !i.error).length;
  pushLog(state, {
    scope: 'crypto',
    kind: 'update',
    text:
      `更新加密货币行情：成功 ${okCount}/${list.length} 个，价格贡献 ${totalChange >= 0 ? '+' : ''}¥${round(totalChange, 2)}，USD/CNY ${usdCny}` +
      (failedSource.length ? `；已熔断的源：${failedSource.map((s) => s.host).join('、')}` : ''),
  });
  report.summary.totalChange = round(totalChange, 2);
  report.summary.usdCny = usdCny;
  report.sources = crypto.sourceStatus();
  if (okCount < list.length) {
    report.summary.message = `成功 ${okCount}/${list.length} 个币种`;
  }
}

/* ============================================================ 估值快照 */

function decorate(asset, scope, ctx) {
  const qty = num(asset.quantity);
  const isCrypto = scope === 'crypto';
  const price = isCrypto ? num(asset.priceCny) : num(scope === 'fund' ? asset.nav : asset.price);
  const nativePrice = isCrypto ? num(asset.price) : price;

  // 加密货币的汇率：人民币资产为 1，其余按实时 USD/CNY
  const rate = isCrypto ? (asset.currency === 'CNY' ? 1 : ctx.usdCny) : 1;

  // 加密货币的成本口径：数量 × 成本价（原币）× 实时汇率。
  // 刻意不用入库时冻结的人民币金额 —— 那样盈亏会混进汇率变动，
  // 而且一旦入库汇率取错（退回硬编码 7.1）就永久算歪，无法纠正。
  // 现在：盈亏＝「币本身涨跌多少（美元）」，人民币金额按今天的汇率折算给你看。
  const costNative = isCrypto ? round(qty * num(asset.costPrice), 4) : null;
  const cost = isCrypto ? round(costNative * rate, 2) : num(asset.costAmount);

  const marketValue = qty * price;
  const pnl = isCrypto ? round(marketValue - cost, 2) : marketValue - cost;
  const pnlNative = isCrypto ? round(qty * (nativePrice - num(asset.costPrice)), 4) : null;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const avgCost = qty > 0 ? cost / qty : 0;

  // 「自上次更新」：以更新时存下来的价格为基准算出的窗口涨跌。
  // 明细表已经不再显示这一列（用户要求去掉），但总览的
  // 「自上次更新（价格贡献）」还要用它的金额汇总，所以这里继续算。
  const baseline = num(asset.baselinePrice);
  const sinceChangeNative = baseline ? nativePrice - baseline : 0;
  const sinceValueCny = qty * sinceChangeNative * rate;

  // 股票的「总成本 ≡ 数量 × 成本价」必须成立（界面没有单独的总成本输入）。
  // 历史上只改数量不重算总成本，会让均价悄悄变成第三个值 —— 这里把它标出来供界面提示与一键修正。
  const expectedCost = qty * num(asset.costPrice) * rate;
  const costMismatch =
    scope === 'stock' && qty > 0 && num(asset.costPrice) > 0 && Math.abs(cost - expectedCost) > Math.max(1, expectedCost * 0.005);

  /* ------------------------------ 当日涨跌 ------------------------------ */
  // 二级市场当日涨跌（股票=当日涨跌幅，基金=净值日增长率，加密货币=24h 涨跌）。
  // 这里算**两个层次**的数，因为它们在界面上回答的是不同问题：
  //   ① 每单位涨跌了多少（价格口径）—— 百分比是现成的，绝对值按板块分别还原：
  //      股票 —— 直接取「现价 − 昨收」，交易所给的真实值，不去反推百分比；
  //      基金 —— 净值接口只给日增长率，没有昨收净值，按 nav × pct/(100+pct) 反推；
  //      加密 —— 只有 24h 百分比，同样反推（金额是原币）。
  //   ② 这些涨跌折算到**我的持仓**上是多少钱（持仓口径）—— 这才是用户真正关心的
  //      「今天这一项让我赚/亏了多少」，也是明细表里显示的数值。
  const dayChangePct = scope === 'stock' ? asset.changePercent : scope === 'fund' ? asset.dailyReturn : asset.change24h;
  const pct = Number(dayChangePct);
  const hasPct = Number.isFinite(pct);
  let dayChange = null;
  if (scope === 'stock') {
    const prevClose = num(asset.prevClose, 0);
    if (prevClose > 0 && price > 0) dayChange = price - prevClose;
    else if (hasPct && price > 0) dayChange = price - price / (1 + pct / 100);
  } else if (hasPct && nativePrice > 0 && pct > -100) {
    dayChange = nativePrice - nativePrice / (1 + pct / 100);
  }
  // 基金净值 / 加密价格常常很小（0.5314 这种），2 位小数会把涨跌抹成 0.00，所以给到 6 位
  const dayChangeValue = dayChange === null ? null : round(dayChange, 6);
  // 持仓口径：每单位涨跌 × 数量，再按汇率折成人民币。没有当日行情的（停牌 / 净值未公布）为 null。
  const dayValueNative = dayChangeValue === null ? null : round(qty * dayChangeValue, 6);
  const dayValueCny = dayValueNative === null ? null : round(dayValueNative * rate, 2);

  return {
    ...asset,
    scope,
    price,
    nativePrice,
    rate,
    cost,
    costNative,
    expectedCost: round(expectedCost, 2),
    costMismatch,
    avgCost: round(avgCost, 6),
    marketValue: round(marketValue, 2),
    pnl: round(pnl, 2),
    pnlNative,
    pnlPct: round(pnlPct, 2),
    priceDate: scope === 'stock' ? asset.priceDate : scope === 'fund' ? asset.navDate : asset.lastUpdate,
    /** 二级市场当日涨跌（股票=当日涨跌幅，基金=净值日增长率，加密货币=24h 涨跌） */
    dayChangePct: hasPct ? round(pct, 4) : null,
    /** 每个单位当日涨跌了多少（股票/基金＝元，加密＝原币）；数据缺失时为 null */
    dayChangeValue,
    /** 当日涨跌折算到**我的持仓**上赚/亏了多少（原币）：每单位涨跌 × 数量 */
    dayValueNative,
    /** 同上，折算成人民币 —— 明细表「今日盈亏」列显示的就是这个数 */
    dayValueCny,
    // 说明：每单位的价格变动（sinceChange / sinceChangePct）曾经作为
    // 「自上次更新」列输出，该列已被移除，所以不再往外暴露这两个字段。
    // sinceValueCny 仍要给总览的「自上次更新（价格贡献）」汇总用，保留。
    sinceValueCny: round(sinceValueCny, 2),
  };
}

function totalsOf(rows) {
  const marketValue = rows.reduce((s, r) => s + r.marketValue, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const sinceValueCny = rows.reduce((s, r) => s + r.sinceValueCny, 0);
  // 当日涨跌贡献的持仓金额：没有当日行情的（停牌 / 净值未公布）按 0 计，不影响其它项
  const dayValueCny = rows.reduce((s, r) => s + (Number(r.dayValueCny) || 0), 0);
  const pnl = marketValue - cost;
  return {
    marketValue: round(marketValue, 2),
    cost: round(cost, 2),
    pnl: round(pnl, 2),
    pnlPct: cost > 0 ? round((pnl / cost) * 100, 2) : 0,
    /** 今日赚/亏了多少钱（按当日涨跌额 × 持仓） */
    dayValueCny: round(dayValueCny, 2),
    dayPct: marketValue - dayValueCny > 0 ? round((dayValueCny / (marketValue - dayValueCny)) * 100, 2) : 0,
    sinceValueCny: round(sinceValueCny, 2),
    sincePct: marketValue - sinceValueCny > 0 ? round((sinceValueCny / (marketValue - sinceValueCny)) * 100, 2) : 0,
    count: rows.length,
  };
}

/**
 * 生成前端所需的完整快照（估值、权重、定投待执行天数、日志）
 *
 * 「屏蔽」的口径：屏蔽的资产仍然出现在列表里（带标注），但**不参与任何合计** ——
 * 总市值 / 总成本 / 盈亏 / 权重 / 配置条 / 定投合计，全部只看未屏蔽的部分。
 * 目的是「这一项先不算，我想看看剩下的组合长什么样」。
 *
 * @param {object} state
 */
export async function computeState(state) {
  const usdCny = num(state.meta.usdCny, null) || crypto.lastUsdCny() || 7.1;
  const ctx = { usdCny };

  const allStocks = state.stocks.map((a) => decorate(a, 'stock', ctx));
  const allFunds = state.funds.map((a) => decorate(a, 'fund', ctx));
  const allCryptos = state.crypto.map((a) => decorate(a, 'crypto', ctx));

  // 定投待执行交易日（今天仍未执行的天数）—— 屏蔽的基金不参与，也不显示待办
  // 定投待执行交易日（今天仍未执行的天数）。屏蔽的基金现在也照常补算定投，
  // 所以它自己也显示真实待办；而合计（dca.pendingDays）只累加 visible 的行，天然排除屏蔽项。
  const t = today();
  for (const f of allFunds) {
    if (f.dca?.enabled && num(f.dca.amount) > 0) {
      const anchor = f.lastDcaDate || addDays(f.dca.startDate || t, -1);
      const all = await cn.tradingDaysBetween(anchor, t);
      f.pendingDays = all.filter((d) => d >= (f.dca.startDate || '0000-00-00')).length;
    } else {
      f.pendingDays = 0;
    }
  }

  /** 计算某一套口径下的全部合计；keep 决定某个 scope 的哪些行计入 */
  const aggregate = (keep) => {
    const rows = {
      stock: allStocks.filter((r) => keep(r, 'stock')),
      fund: allFunds.filter((r) => keep(r, 'fund')),
      crypto: allCryptos.filter((r) => keep(r, 'crypto')),
    };
    const byScope = {
      stock: totalsOf(rows.stock),
      fund: totalsOf(rows.fund),
      crypto: totalsOf(rows.crypto),
    };
    // 加密货币额外给一个「原币盈亏」合计，供界面直接显示「赚了多少美元」
    byScope.crypto.pnlNative = round(
      rows.crypto.reduce((sum, r) => sum + (Number(r.pnlNative) || 0), 0),
      4,
    );
    byScope.crypto.costNative = round(
      rows.crypto.reduce((sum, r) => sum + (Number(r.costNative) || 0), 0),
      4,
    );
    const allRows = [...rows.stock, ...rows.fund, ...rows.crypto];
    return { rows, byScope, allRows, totals: totalsOf(allRows) };
  };

  // 只有一套口径：屏蔽项不计入。accounting 上「屏蔽」就等于把它移出组合，
  // 但记录与行情都留在盘里可以随时还原 —— 所以不需要第二套「含屏蔽项」的合计。
  const visible = aggregate((r) => !r.hidden);
  // 屏蔽项自己的合计（行情照常更新，取的就是最新数），只用于说明「排除掉了多少」，不参与任何主口径
  const raw = aggregate(() => true);
  const hiddenRows = {
    stock: allStocks.filter((r) => r.hidden),
    fund: allFunds.filter((r) => r.hidden),
    crypto: allCryptos.filter((r) => r.hidden),
  };

  const hiddenCount = {
    stock: hiddenRows.stock.length,
    fund: hiddenRows.fund.length,
    crypto: hiddenRows.crypto.length,
  };
  hiddenCount.total = hiddenCount.stock + hiddenCount.fund + hiddenCount.crypto;

  const scopeRows = { stock: allStocks, fund: allFunds, crypto: allCryptos };
  const byScope = visible.byScope;
  const totals = visible.totals;

  // 权重按「未屏蔽」的总市值归一，读数与账页上的合计一致
  for (const scope of SCOPES) {
    for (const row of scopeRows[scope]) {
      row.weight = totals.marketValue > 0 ? round((row.marketValue / totals.marketValue) * 100, 2) : 0;
    }
  }

  const allocation = visible.allRows
    .map((r) => ({
      id: r.id,
      scope: r.scope,
      name: r.name,
      code: r.code || r.symbol || r.coinId,
      note: r.note || '',
      hidden: Boolean(r.hidden),
      value: r.marketValue,
      weight: r.weight,
    }))
    .sort((a, b) => b.value - a.value);

  const dcaFunds = visible.rows.fund.filter((f) => f.dca?.enabled && num(f.dca.amount) > 0);
  const dca = {
    enabledFunds: dcaFunds.length,
    dailyAmount: round(dcaFunds.reduce((s, f) => s + num(f.dca.amount), 0), 2),
    totalInvested: round(visible.rows.fund.reduce((s, f) => s + num(f.dcaInvested), 0), 2),
    totalCount: visible.rows.fund.reduce((s, f) => s + num(f.dcaCount), 0),
    totalUnits: round(visible.rows.fund.reduce((s, f) => s + num(f.dcaUnits), 0), 4),
    pendingDays: dcaFunds.reduce((s, f) => s + num(f.pendingDays), 0),
    hiddenCount: hiddenCount.fund,
  };

  return {
    ...state,
    stocks: allStocks,
    funds: allFunds,
    crypto: allCryptos,
    computed: {
      quoteAt: state.meta.quoteAt,
      usdCny,
      usdCnyAt: state.meta.usdCnyAt,
      totals,
      byScope,
      /** 「含屏蔽项」的合计（屏蔽项行情照常更新）——只用来算「已排除多少」 */
      byScopeRaw: raw.byScope,
      allocation,
      dca,
      hiddenCount,
      /** 被屏蔽的行（按板块分组），供前端「显示屏蔽项」时列出 */
      hiddenRows,
      logs: [...state.logs].reverse().slice(0, 60),
      dcaLogs: [...state.logs].filter((l) => l.kind === 'dca').reverse().slice(0, 40),
      today: t,
    },
  };
}

export { SCOPE_LABEL };
