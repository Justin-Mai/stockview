/**
 * A 股 / 公募基金行情 Provider
 * 数据来源：stock-sdk（https://github.com/chengzuopeng/stock-sdk）
 * 底层为腾讯财经 / 东方财富公开接口，零依赖直连。
 *
 * 关键能力：
 *  - 实时行情：sdk.quotes.cnSimple / sdk.quotes.fund
 *  - 历史日线：sdk.kline.cn
 *  - 基金历史净值：sdk.fund.navHistory（定投按交易日净值折算份额的依据）
 *  - 交易日历：sdk.reference.tradingCalendar（一次性返回 1990 至今 + 未来的交易日）
 */

import { StockSDK } from 'stock-sdk';
import { compact, today, toDateStr } from '../util.js';

const sdk = new StockSDK({
  retry: { maxRetries: 2, baseDelay: 400 },
  providerPolicies: {
    eastmoney: { timeout: 15000, rateLimit: { requestsPerSecond: 4, maxBurst: 4 } },
    tencent: { timeout: 12000, rateLimit: { requestsPerSecond: 6, maxBurst: 6 } },
  },
});

export { sdk };

/* ------------------------------------------------------------------ 交易日历 */

let calendarCache = { at: 0, days: null, first: null, last: null };
const CAL_TTL = 6 * 60 * 60 * 1000; // 6 小时

/** 交易日集合（Set<string>），带内存缓存 */
export async function tradingDays() {
  if (calendarCache.days && Date.now() - calendarCache.at < CAL_TTL) return calendarCache.days;
  try {
    const list = await sdk.reference.tradingCalendar();
    const days = new Set((list || []).map((d) => toDateStr(d)).filter(Boolean));
    if (days.size > 0) {
      const sorted = [...days].sort();
      calendarCache = { at: Date.now(), days, first: sorted[0], last: sorted[sorted.length - 1] };
      return days;
    }
  } catch {
    // 日历接口不可用时退化为「工作日近似判断」，不让整个更新流程失败
  }
  if (!calendarCache.days) {
    const days = new Set();
    const start = new Date();
    start.setUTCFullYear(start.getUTCFullYear() - 3);
    for (let i = 0; i < 1200; i += 1) {
      const d = new Date(start.getTime() + i * 86400000);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) days.add(d.toISOString().slice(0, 10));
    }
    calendarCache = { at: Date.now(), days, first: null, last: null, fallback: true };
  }
  return calendarCache.days;
}

/** 单个日期是否交易日（优先本地日历，越界时回退接口） */
export async function isTradingDay(dateStr) {
  const d = toDateStr(dateStr);
  if (!d) return false;
  const days = await tradingDays();
  if (calendarCache.first && calendarCache.last && d >= calendarCache.first && d <= calendarCache.last) {
    return days.has(d);
  }
  try {
    return await sdk.calendar.isTradingDay(d);
  } catch {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6;
  }
}

/**
 * 返回 (from, to] 区间内的交易日数组（升序）。
 * @param {string|null} from 起始日期（不含）
 * @param {string} to 结束日期（含）
 * @param {number} maxDays 上限，防止首次导入时算出几百天
 */
export async function tradingDaysBetween(from, to, maxDays = 400) {
  const end = toDateStr(to) || today();
  const days = await tradingDays();
  const start = from ? toDateStr(from) : null;
  const out = [...days].filter((d) => d <= end && (!start || d > start)).sort();
  return out.slice(-maxDays);
}

/** 上一个交易日（不含当天） */
export async function prevTradingDay(dateStr) {
  const d = toDateStr(dateStr) || today();
  const days = await tradingDays();
  const before = [...days].filter((x) => x < d).sort();
  return before.length ? before[before.length - 1] : null;
}

/* -------------------------------------------------------------------- 行情 */

/** A 股实时行情 */
export async function stockQuotes(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await sdk.quotes.cnSimple(list);
  return new Map(rows.map((r) => [r.code, r]));
}

/** 公募基金实时净值 */
export async function fundQuotes(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await sdk.quotes.fund(list);
  return new Map(rows.map((r) => [r.code, r]));
}

/**
 * 日线（默认不复权，用真实市价做持仓市值）
 * @returns {Array<{date:string, close:number, prevClose:number|null, changePercent:number|null}>}
 */
export async function dailyKline(code, { start, end, adjust = '' } = {}) {
  const rows = await sdk.kline.cn(code, {
    period: 'daily',
    adjust,
    startDate: compact(start),
    endDate: compact(end),
  });
  const sorted = (rows || []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return sorted.map((r, i) => ({
    date: toDateStr(r.date),
    open: r.open,
    close: r.close,
    high: r.high,
    low: r.low,
    volume: r.volume,
    changePercent: r.changePercent,
    prevClose: i > 0 ? sorted[i - 1].close : null,
  }));
}

/**
 * 基金历史净值
 * @returns {{name:string|null, items:Array<{date:string, nav:number|null, accNav:number|null, dailyReturn:number|null}>}}
 */
export async function fundNavHistory(code) {
  const res = await sdk.fund.navHistory(code);
  const items = (res?.items || [])
    .map((it) => ({
      date: toDateStr(it.date),
      nav: it.nav === null || it.nav === undefined ? null : Number(it.nav),
      accNav: it.accNav === null || it.accNav === undefined ? null : Number(it.accNav),
      dailyReturn: it.dailyReturn === null || it.dailyReturn === undefined ? null : Number(it.dailyReturn),
    }))
    .filter((it) => it.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { code: res?.code || code, name: res?.name ?? null, items };
}

/** 去掉行情源给的前缀：sh600519 / sz000858 / jj110022 → 600519 / 000858 / 110022 */
export function normalizeCode(input) {
  const s = String(input ?? '').trim();
  return /^(sh|sz|bj|jj)/i.test(s) ? s.slice(2) : s;
}

/** 代码/名称/拼音模糊搜索（股票、指数、基金） */
export async function searchSymbol(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const rows = await sdk.search(kw);
  return (rows || []).slice(0, 20).map((r) => {
    const full = String(r.code || '');
    const code = normalizeCode(full);
    const type = String(r.assetType ?? r.type ?? '');
    return {
      code,
      fullCode: full,
      name: r.name,
      market: r.market ?? null,
      assetType: type || null,
      // 场内基金/ETF 代码以 5 / 15 / 16 / 18 开头，场外基金多以 0 / 1 / 2 / 3 开头
      kind: /^(jj|fund)/i.test(full) || /fund|ETF|LOF/i.test(type) ? 'fund' : 'stock',
    };
  });
}

/** 单只标的的名称+最新价（新增资产时预览用） */
export async function lookupSymbol(scope, code) {
  const clean = normalizeCode(code);
  if (!clean) throw new Error('代码不能为空');
  if (scope === 'fund') {
    const map = await fundQuotes([clean]);
    const q = map.get(clean);
    let name = q?.name ?? null;
    let nav = q?.nav ?? null;
    let navDate = q?.navDate ?? null;
    if (nav === null) {
      try {
        const hist = await fundNavHistory(clean);
        name = name || hist.name;
        const last = [...hist.items].reverse().find((it) => it.nav !== null);
        if (last) {
          nav = last.nav;
          navDate = last.date;
        }
      } catch {
        /* 忽略：仍返回名称 */
      }
    }
    if (nav === null && !name) throw new Error(`未找到基金 ${clean}`);
    return { code: clean, name, price: nav, priceDate: navDate, priceLabel: '单位净值' };
  }
  const map = await stockQuotes([clean]);
  const q = map.get(clean) || [...map.values()][0];
  if (!q) throw new Error(`未找到股票 ${clean}（请检查代码，A 股需 6 位数字）`);
  return { code: q.code, name: q.name, price: q.price, changePercent: q.changePercent, priceDate: today(), priceLabel: '最新价' };
}
