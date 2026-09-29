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
import { addDays, dayDiff, HISTORY_CAP, makeId, nowStamp, num, round, today, toDateStr } from './util.js';

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
  const quantity = round(num(data.quantity), 8);
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
    history: [],
    lastUpdate: null,
    baselinePrice: null,
    baselineDate: null,
  };
}

export function addAsset(state, scope, data = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`未知板块 ${scope}`);
  const code = String(data.code ?? '').trim();
  if (!code) throw new Error('代码不能为空');
  const name = String(data.name ?? '').trim() || code;
  const quantity = round(num(data.quantity), 8);
  if (quantity < 0) throw new Error('数量不能为负');
  const costPrice = round(num(data.costPrice), 6);

  if (scope === 'crypto') {
    const list = state.crypto;
    if (list.some((x) => x.coinId === code)) throw new Error(`${name} 已在加密货币列表中`);
    const currency = data.currency === 'CNY' ? 'CNY' : 'USD';
    const usdCny = num(state.meta.usdCny, 7.1) || 7.1;
    const rate = currency === 'CNY' ? 1 : usdCny;
    const asset = {
      ...baseAsset(scope, data),
      coinId: code,
      symbol: String(data.symbol ?? '').trim().toUpperCase() || code.toUpperCase(),
      name,
      currency,
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
    if (list.some((x) => x.code === code)) throw new Error(`${name}(${code}) 已在股票列表中`);
    const asset = {
      ...baseAsset(scope, data),
      code,
      name,
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
  if (list.some((x) => x.code === code)) throw new Error(`${name}(${code}) 已在基金列表中`);
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

const FUND_EDITABLE = ['code', 'name', 'quantity', 'costAmount', 'costPrice', 'note'];
const STOCK_EDITABLE = ['code', 'name', 'quantity', 'costAmount', 'costPrice', 'note'];
const CRYPTO_EDITABLE = ['name', 'symbol', 'quantity', 'costAmount', 'costPrice', 'currency', 'note'];

export function updateAsset(state, scope, id, data = {}) {
  const list = state[scope === 'stock' ? 'stocks' : scope === 'fund' ? 'funds' : 'crypto'];
  if (!list) throw new Error(`未知板块 ${scope}`);
  const asset = list.find((x) => x.id === id);
  if (!asset) throw new Error('未找到该资产');

  const before = { quantity: asset.quantity, costAmount: asset.costAmount };
  const fields = scope === 'crypto' ? CRYPTO_EDITABLE : scope === 'fund' ? FUND_EDITABLE : STOCK_EDITABLE;
  for (const key of fields) {
    if (data[key] === undefined) continue;
    if (key === 'quantity') asset.quantity = round(num(data.quantity), 8);
    else if (key === 'costAmount') asset.costAmount = round(num(data.costAmount), 2);
    else if (key === 'costPrice') asset.costPrice = round(num(data.costPrice), 6);
    else asset[key] = String(data[key] ?? '').trim();
  }

  // 成本价 / 成本额 的联动规则：
  //  显式给了 costAmount → 直接采用；否则若给了 costPrice → 用数量×成本价重算总成本
  if (data.costAmount === undefined && data.costPrice !== undefined) {
    if (scope === 'crypto') {
      const usdCny = num(state.meta.usdCny, 7.1) || 7.1;
      const rate = asset.currency === 'CNY' ? 1 : usdCny;
      asset.costAmount = round(asset.quantity * asset.costPrice * rate, 2);
    } else {
      asset.costAmount = round(asset.quantity * asset.costPrice, 2);
    }
  }

  // 加密货币直接改数量/成本时，同步成本价
  if (scope === 'crypto') {
    if (data.currency !== undefined) asset.currency = data.currency === 'CNY' ? 'CNY' : 'USD';
    if (data.quantity !== undefined || data.costPrice !== undefined || data.currency !== undefined) {
      const usdCny = num(state.meta.usdCny, 7.1) || 7.1;
      const rate = asset.currency === 'CNY' ? 1 : usdCny;
      asset.costAmount = round(asset.quantity * asset.costPrice * rate, 2);
    }
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

  asset.updatedAt = nowStamp();
  pushLog(state, {
    scope,
    kind: 'edit',
    assetId: asset.id,
    text: `修改 ${asset.name}：持仓 ${before.quantity} → ${asset.quantity}，总成本 ¥${before.costAmount} → ¥${asset.costAmount}${scope === 'fund' ? `，日定投 ${asset.dca.enabled ? '¥' + asset.dca.amount : '关闭'}` : ''}`,
  });
  return asset;
}

export function deleteAsset(state, scope, id) {
  const key = scope === 'stock' ? 'stocks' : scope === 'fund' ? 'funds' : scope === 'crypto' ? 'crypto' : null;
  if (!key) throw new Error(`未知板块 ${scope}`);
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
      const map = await crypto.getPrices([asset.coinId], { [asset.coinId]: asset.symbol });
      const p = map.get(asset.coinId);
      if (p?.priceCny) {
        asset.priceCny = p.priceCny;
        asset.priceUsd = p.priceUsd;
        asset.price = asset.currency === 'CNY' ? p.priceCny : p.priceUsd;
        asset.change24h = p.change24h;
        asset.priceSource = p.source;
      }
    }
  } catch {
    // 拿不到就沿用成本价占位，用户点「更新」时会再试一次
  }
  return asset;
}

/**
 * 执行一次更新。
 * @param {object} state
 * @param {'stock'|'fund'|'crypto'} scope
 * @returns {Promise<{scope:string, summary:object, items:Array, errors:Array}>}
 */
export async function runUpdate(state, scope) {
  if (!SCOPES.includes(scope)) throw new Error(`未知板块 ${scope}`);
  const startedAt = nowStamp();
  const report = { scope, startedAt, finishedAt: null, summary: {}, items: [], errors: [] };

  if (scope === 'stock') await updateStocks(state, report);
  else if (scope === 'fund') await updateFunds(state, report);
  else await updateCryptos(state, report);

  state.meta.lastUpdate[scope] = today();
  state.meta.quoteAt = nowStamp();
  report.finishedAt = nowStamp();
  report.summary.label = SCOPE_LABEL[scope];
  report.summary.updated = report.items.filter((x) => !x.error).length;
  report.summary.failed = report.errors.length;
  return report;
}

/* --------------------------------------------------------------- 股票 */

async function updateStocks(state, report) {
  const list = state.stocks;
  if (!list.length) {
    report.summary.message = '股票列表为空，没有需要更新的持仓';
    return;
  }
  const t = today();
  let totalChange = 0;
  let totalValue = 0;

  for (const stock of list) {
    const item = { id: stock.id, code: stock.code, name: stock.name };
    try {
      const from = stock.lastUpdate ? addDays(stock.lastUpdate, -LOOKBACK_DAYS) : addDays(t, -LOOKBACK_DAYS);
      const bars = await cn.dailyKline(stock.code, { start: from, end: t });
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
      item.error = err.message || String(err);
      // 只有在该标的此前成功取过行情时才推进日期；
      // 否则（比如代码写错）保持 lastUpdate 为空，修好后首次更新仍会用「上一交易日」作基准
      if (stock.lastQuoteDate) stock.lastUpdate = t;
      report.items.push(item);
      report.errors.push({ id: stock.id, code: stock.code, name: stock.name, message: item.error });
    }
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

async function updateFunds(state, report) {
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
    const item = { id: fund.id, code: fund.code, name: fund.name };
    try {
      const hist = await cn.fundNavHistory(fund.code);
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
          fund.quantity = round(fund.quantity + units, 8);
          fund.costAmount = round(fund.costAmount + dailyAmount, 2);
          fund.dcaCount = num(fund.dcaCount) + 1;
          fund.dcaInvested = round(num(fund.dcaInvested) + dailyAmount, 2);
          fund.dcaUnits = round(num(fund.dcaUnits) + units, 8);
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
      item.error = err.message || String(err);
      if (fund.navDate) fund.lastUpdate = today();
      report.items.push(item);
      report.errors.push({ id: fund.id, code: fund.code, name: fund.name, message: item.error });
    }
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

async function updateCryptos(state, report) {
  const list = state.crypto;
  if (!list.length) {
    report.summary.message = '加密货币列表为空，没有需要更新的持仓';
    return;
  }
  const t = today();
  let totalChange = 0;

  // 汇率先刷新一次，供成本/市值折算
  try {
    const rate = await crypto.getUsdCny();
    if (rate) {
      state.meta.usdCny = rate;
      state.meta.usdCnyAt = nowStamp();
    }
  } catch {
    /* 沿用旧汇率 */
  }
  const usdCny = num(state.meta.usdCny, 7.1) || 7.1;

  const symbols = Object.fromEntries(list.map((x) => [x.coinId, x.symbol]).filter(([, s]) => s));
  const prices = await crypto.getPrices(list.map((x) => x.coinId), symbols);

  for (const coin of list) {
    const item = { id: coin.id, coinId: coin.coinId, name: coin.name, symbol: coin.symbol };
    try {
      const p = prices.get(coin.coinId);
      if (!p || p.priceCny === null) throw new Error('未取到价格（CoinGecko / OKX 均无返回）');

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
          );
          if (hist.length) {
            coin.baselinePrice = hist[0].price;
            coin.baselineDate = hist[0].date;
            coin.history = mergeHistory(coin.history, hist.map((h) => ({ date: h.date, price: h.price })));
          }
        } catch {
          /* 忽略：不影响现价更新 */
        }
      }

      coin.priceCny = p.priceCny;
      coin.priceUsd = p.priceUsd;
      coin.change24h = p.change24h;
      coin.price = coin.currency === 'CNY' ? p.priceCny : p.priceUsd;
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
    } catch (err) {
      item.error = err.message || String(err);
      if (coin.baselinePrice) coin.lastUpdate = t;
      report.items.push(item);
      report.errors.push({ id: coin.id, coinId: coin.coinId, name: coin.name, message: item.error });
    }
  }

  pushLog(state, {
    scope: 'crypto',
    kind: 'update',
    text: `更新加密货币行情：成功 ${report.items.filter((i) => !i.error).length}/${list.length} 个，价格贡献 ${totalChange >= 0 ? '+' : ''}¥${round(totalChange, 2)}，USD/CNY ${usdCny}`,
  });
  report.summary.totalChange = round(totalChange, 2);
  report.summary.usdCny = usdCny;
}

/* ============================================================ 估值快照 */

function decorate(asset, scope, ctx) {
  const qty = num(asset.quantity);
  const isCrypto = scope === 'crypto';
  const price = isCrypto ? num(asset.priceCny) : num(scope === 'fund' ? asset.nav : asset.price);
  const nativePrice = isCrypto ? num(asset.price) : price;
  const cost = num(asset.costAmount);
  const marketValue = qty * price;
  const pnl = marketValue - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const avgCost = qty > 0 ? cost / qty : 0;

  const baseline = num(asset.baselinePrice);
  const sinceChangeNative = baseline ? nativePrice - baseline : 0;
  const sinceChangePct = baseline ? (sinceChangeNative / baseline) * 100 : 0;
  const rate = isCrypto && asset.currency === 'CNY' ? 1 : isCrypto ? ctx.usdCny : 1;
  const sinceValueCny = qty * sinceChangeNative * rate;

  return {
    ...asset,
    scope,
    price,
    nativePrice,
    cost,
    avgCost: round(avgCost, 6),
    marketValue: round(marketValue, 2),
    pnl: round(pnl, 2),
    pnlPct: round(pnlPct, 2),
    priceDate: scope === 'stock' ? asset.priceDate : scope === 'fund' ? asset.navDate : asset.lastUpdate,
    /** 二级市场当日涨跌（股票=当日涨跌幅，基金=净值日增长率，加密货币=24h 涨跌） */
    dayChangePct: scope === 'stock' ? asset.changePercent : scope === 'fund' ? asset.dailyReturn : asset.change24h,
    sinceChange: round(sinceChangeNative, 6),
    sinceChangePct: round(sinceChangePct, 2),
    sinceValueCny: round(sinceValueCny, 2),
  };
}

function totalsOf(rows) {
  const marketValue = rows.reduce((s, r) => s + r.marketValue, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const sinceValueCny = rows.reduce((s, r) => s + r.sinceValueCny, 0);
  const pnl = marketValue - cost;
  return {
    marketValue: round(marketValue, 2),
    cost: round(cost, 2),
    pnl: round(pnl, 2),
    pnlPct: cost > 0 ? round((pnl / cost) * 100, 2) : 0,
    sinceValueCny: round(sinceValueCny, 2),
    sincePct: marketValue - sinceValueCny > 0 ? round((sinceValueCny / (marketValue - sinceValueCny)) * 100, 2) : 0,
    count: rows.length,
  };
}

/**
 * 生成前端所需的完整快照（估值、权重、定投待执行天数、日志）
 * @param {object} state
 */
export async function computeState(state) {
  const usdCny = num(state.meta.usdCny, 7.1) || 7.1;
  const ctx = { usdCny };

  const stocks = state.stocks.map((a) => decorate(a, 'stock', ctx));
  const funds = state.funds.map((a) => decorate(a, 'fund', ctx));
  const cryptos = state.crypto.map((a) => decorate(a, 'crypto', ctx));

  // 定投待执行交易日（今天仍未执行的天数）
  const t = today();
  for (const f of funds) {
    if (f.dca?.enabled && num(f.dca.amount) > 0) {
      const anchor = f.lastDcaDate || addDays(f.dca.startDate || t, -1);
      const all = await cn.tradingDaysBetween(anchor, t);
      f.pendingDays = all.filter((d) => d >= (f.dca.startDate || '0000-00-00')).length;
    } else {
      f.pendingDays = 0;
    }
  }

  const scopeRows = { stock: stocks, fund: funds, crypto: cryptos };
  const byScope = {
    stock: totalsOf(stocks),
    fund: totalsOf(funds),
    crypto: totalsOf(cryptos),
  };
  const allRows = [...stocks, ...funds, ...cryptos];
  const totals = totalsOf(allRows);

  for (const scope of SCOPES) {
    for (const row of scopeRows[scope]) {
      row.weight = totals.marketValue > 0 ? round((row.marketValue / totals.marketValue) * 100, 2) : 0;
    }
  }

  const allocation = allRows
    .map((r) => ({ id: r.id, scope: r.scope, name: r.name, code: r.code || r.symbol || r.coinId, value: r.marketValue, weight: r.weight }))
    .sort((a, b) => b.value - a.value);

  const dcaFunds = funds.filter((f) => f.dca?.enabled && num(f.dca.amount) > 0);
  const dca = {
    enabledFunds: dcaFunds.length,
    dailyAmount: round(dcaFunds.reduce((s, f) => s + num(f.dca.amount), 0), 2),
    totalInvested: round(funds.reduce((s, f) => s + num(f.dcaInvested), 0), 2),
    totalCount: funds.reduce((s, f) => s + num(f.dcaCount), 0),
    totalUnits: round(funds.reduce((s, f) => s + num(f.dcaUnits), 0), 4),
    pendingDays: dcaFunds.reduce((s, f) => s + num(f.pendingDays), 0),
  };

  return {
    ...state,
    stocks,
    funds,
    crypto: cryptos,
    computed: {
      quoteAt: state.meta.quoteAt,
      usdCny,
      usdCnyAt: state.meta.usdCnyAt,
      totals,
      byScope,
      allocation,
      dca,
      logs: [...state.logs].reverse().slice(0, 60),
      dcaLogs: [...state.logs].filter((l) => l.kind === 'dca').reverse().slice(0, 40),
      today: t,
    },
  };
}

export { SCOPE_LABEL };
