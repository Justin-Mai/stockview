/**
 * 演示数据构造器。
 *
 * 两个设计要点：
 *  1. 刻意把「上次更新」设为 5 个交易日之前，这样首次点击「更新」就能看到
 *     真实的行情变化 + 定投按交易日补算的效果。
 *  2. 抓行情全部并行（受行情源限流约束），并通过 onProgress 回调实时汇报进度 ——
 *     整个构造需要联网，串行时长达 7 秒以上，必须有可见反馈。
 */

import * as cn from './providers/cn.js';
import * as crypto from './providers/crypto.js';
import { addAsset } from './portfolio.js';
import { emptyState } from './store.js';
import { addDays, HISTORY_CAP, mapLimit, num, nowStamp, round, today } from './util.js';

/** 基准日相对今天的位置：5 个交易日之前 */
const ANCHOR_BACK_STEPS = 5;
/** 并行抓行情的并发度 */
const FETCH_CONCURRENCY = 4;

const STOCK_SPECS = [
  { code: '600519', name: '贵州茅台', quantity: 100, costPrice: 1180.5 },
  { code: '000858', name: '五粮液', quantity: 300, costPrice: 132.4 },
  { code: '300750', name: '宁德时代', quantity: 200, costPrice: 268.9 },
];

const FUND_SPECS = [
  { code: '110022', name: '易方达消费行业股票', quantity: 1200, costPrice: 2.62, amount: 100 },
  { code: '161725', name: '招商中证白酒指数A', quantity: 8000, costPrice: 0.538, amount: 50 },
  { code: '000961', name: '天弘沪深300ETF联接A', quantity: 3000, costPrice: 1.42, amount: 200 },
];

const COIN_SPECS = [
  { code: 'bitcoin', name: '比特币', symbol: 'BTC', quantity: 0.35, costPrice: 61200, currency: 'USD' },
  { code: 'ethereum', name: '以太坊', symbol: 'ETH', quantity: 6, costPrice: 2380, currency: 'USD' },
];

/** 基准日：5 个交易日之前 */
async function anchorDate() {
  const days = await cn.tradingDaysBetween(addDays(today(), -30), today());
  if (days.length > ANCHOR_BACK_STEPS + 1) return days[days.length - ANCHOR_BACK_STEPS - 1];
  return addDays(today(), -7);
}

/**
 * 构造演示数据
 * @param {{withCrypto?: boolean, onProgress?: (p:{step:number,total:number,label:string})=>void}} options
 */
export async function buildDemoState({ withCrypto = true, onProgress = () => {} } = {}) {
  const state = emptyState();
  const coins = withCrypto ? COIN_SPECS : [];

  // 步数：汇率 1 + 基准日 1 + 每只股票/基金/币各 1 + 币价 1
  const total = 2 + STOCK_SPECS.length + FUND_SPECS.length + (withCrypto ? 1 + coins.length : 0);
  let step = 0;
  const say = (label) => onProgress({ step, total, label });
  const tick = (label) => {
    step += 1;
    onProgress({ step, total, label });
  };

  /* ---------------------------- 1. 汇率 ---------------------------- */
  say('正在获取 USD/CNY 汇率…');
  try {
    state.meta.usdCny = await crypto.getUsdCny();
  } catch {
    state.meta.usdCny = 7.1;
  }
  tick(`汇率已获取（1 USD ≈ ${state.meta.usdCny} CNY）`);

  /* -------------------------- 2. 基准交易日 -------------------------- */
  say('正在读取 A 股交易日历…');
  const anchor = await anchorDate();
  tick(`基准日已确定：${anchor}（${ANCHOR_BACK_STEPS} 个交易日之前）`);

  /* ------------------- 3. 先把资产建出来（纯本地） ------------------- */
  const stockJobs = STOCK_SPECS.map((spec) => ({ spec, asset: addAsset(state, 'stock', spec) }));
  const fundJobs = FUND_SPECS.map((spec) => ({
    spec,
    asset: addAsset(state, 'fund', {
      code: spec.code,
      name: spec.name,
      quantity: spec.quantity,
      costPrice: spec.costPrice,
      dca: { enabled: true, amount: spec.amount, startDate: addDays(anchor, -20) },
    }),
  }));
  const coinJobs = coins.map((spec) => ({ spec, asset: addAsset(state, 'crypto', spec) }));

  /* ------------------------ 4. 并行抓股市行情 ------------------------ */
  await mapLimit(stockJobs, FETCH_CONCURRENCY, async ({ spec, asset }) => {
    say(`正在获取 ${spec.name} 日线…`);
    try {
      const bars = await cn.dailyKline(spec.code, { start: addDays(anchor, -40), end: today() });
      if (bars.length) {
        const at = [...bars].reverse().find((b) => b.date <= anchor) || bars[0];
        // 把「上次更新时用户看到的价格」设为锚点当天的收盘价，
        // 这样点击更新后能真实反映出这段窗口的涨跌
        asset.baselinePrice = at.close;
        asset.baselineDate = at.date;
        asset.price = at.close;
        asset.priceDate = at.date;
        asset.lastQuoteDate = at.date;
        asset.prevClose = at.close;
        asset.changePercent = at.changePercent;
        asset.lastUpdate = at.date;
        asset.history = bars.slice(-HISTORY_CAP).map((b) => ({ date: b.date, close: b.close }));
      }
    } catch {
      /* 单只失败不影响整体 */
    }
    tick(`${spec.name} 日线已获取`);
  });

  /* ------------------------ 5. 并行抓基金净值 ------------------------ */
  await mapLimit(fundJobs, FETCH_CONCURRENCY, async ({ spec, asset }) => {
    say(`正在获取 ${spec.name} 历史净值…`);
    try {
      const hist = await cn.fundNavHistory(spec.code);
      const withNav = hist.items.filter((it) => it.nav !== null && it.nav > 0);
      if (withNav.length) {
        const at = [...withNav].reverse().find((it) => it.date <= anchor) || withNav[0];
        asset.baselinePrice = at.nav;
        asset.baselineDate = at.date;
        asset.nav = at.nav;
        asset.navDate = at.date;
        asset.dailyReturn = at.dailyReturn ?? null;
        asset.accNav = at.accNav ?? null;
        asset.lastUpdate = at.date;
        asset.lastDcaDate = at.date;
        // 基金净值接口返回成立以来全量（老基金可达数千条），只留最近一段
        asset.history = withNav.slice(-HISTORY_CAP).map((it) => ({ date: it.date, nav: it.nav }));
      }
    } catch {
      /* 忽略 */
    }
    tick(`${spec.name} 净值已获取`);
  });

  /* ------------------------ 6. 加密货币行情 ------------------------ */
  if (withCrypto && coinJobs.length) {
    say('正在获取加密货币现价…');
    let prices = new Map();
    try {
      prices = await crypto.getPrices(
        coinJobs.map((j) => j.spec.code),
        Object.fromEntries(coinJobs.map((j) => [j.spec.code, j.spec.symbol])),
      );
    } catch {
      /* 忽略 */
    }
    tick('币价已获取');

    await mapLimit(coinJobs, 2, async ({ spec, asset }) => {
      say(`正在获取 ${spec.name} 历史走势…`);
      const p = prices.get(asset.coinId);
      if (p?.priceCny) {
        asset.priceCny = p.priceCny;
        asset.priceUsd = p.priceUsd;
        asset.price = asset.currency === 'CNY' ? p.priceCny : p.priceUsd;
        asset.change24h = p.change24h;
        asset.priceSource = p.source;
      }
      try {
        const hist = await crypto.priceHistory(asset.coinId, addDays(anchor, -10), anchor, 'cny', asset.symbol);
        if (hist.length) {
          const at = hist[hist.length - 1];
          const rate = num(state.meta.usdCny, 7.1) || 7.1;
          asset.priceCny = at.price;
          asset.priceUsd = round(at.price / rate, 4);
          asset.price = asset.currency === 'CNY' ? at.price : asset.priceUsd;
          asset.baselinePrice = asset.price;
          asset.baselineDate = at.date;
          asset.lastUpdate = at.date;
          // 基准价取自 OKX 日线，来源标记同步更新，界面上能看出这条数据的出处
          asset.priceSource = 'okx';
          asset.history = hist.slice(-HISTORY_CAP).map((h) => ({ date: h.date, price: h.price }));
        }
      } catch {
        /* 忽略 */
      }
      tick(`${spec.name} 走势已获取`);
    });
  }

  /* ------------------------------ 收尾 ------------------------------ */
  state.meta.quoteAt = `${anchor} 15:00:00`;
  state.meta.lastUpdate = { stock: anchor, fund: anchor, crypto: anchor };
  state.logs = [
    {
      id: 'log_seed',
      ts: nowStamp(),
      scope: 'fund',
      kind: 'add',
      text: `已生成演示数据：3 只股票 / 3 只基金（均开启日定投）/ 2 种加密货币，上次更新日期统一设为 ${anchor}，点击任意板块的「更新」即可看到行情变化与定投按交易日补算。`,
    },
  ];
  return state;
}
