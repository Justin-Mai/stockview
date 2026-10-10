/**
 * 隔离验证：屏蔽的资产是否仍然会被更新。
 *
 * 用**合成 state**（不读写 data/portfolio.json），分别跑一遍基金与加密货币板块：
 *   - 基金：屏蔽后是否仍然取净值、是否仍然补算定投
 *   - 加密货币：屏蔽后是否仍然取价
 * 预期：hidden 的项照常拿到数据，同时 hidden 标记不被改动。
 *
 * 用法：node scripts/check-hidden-update.mjs
 */
import { runUpdate } from '../server/portfolio.js';

const fund = {
  id: 'f_test',
  code: '008163',
  name: '南方红利低波50ETF联接A',
  quantity: 1000,
  costAmount: 2000,
  costPrice: 2,
  hidden: true, // ← 关键：屏蔽状态
  dca: { enabled: true, amount: 10, frequency: 'daily', startDate: '2026-09-25' },
  lastDcaDate: null,
  dcaCount: 0,
  dcaUnits: 0,
  dcaInvested: 0,
  nav: null,
  navDate: null,
  accNav: null,
  dailyReturn: null,
  baselinePrice: null,
  baselineDate: null,
  lastUpdate: null,
  history: [],
  note: '',
};

const coin = {
  id: 'c_test',
  coinId: 'bitcoin',
  symbol: 'BTC',
  name: '比特币',
  currency: 'USD',
  quantity: 0.01,
  costAmount: 5000,
  costPrice: 75000,
  hidden: true, // ← 关键：屏蔽状态
  price: null,
  priceCny: null,
  priceUsd: null,
  change24h: null,
  baselinePrice: null,
  baselineDate: null,
  lastUpdate: null,
  history: [],
  note: '',
};

const state = {
  meta: { usdCny: 6.7, usdCnyAt: null, lastUpdate: { stock: null, fund: null, crypto: null } },
  stocks: [],
  funds: [fund],
  crypto: [coin],
  logs: [],
};

const before = {
  fundNav: fund.nav,
  fundQty: fund.quantity,
  coinPrice: coin.priceUsd,
};

console.log('=== 基金板块（屏蔽状态）===');
const rf = await runUpdate(state, 'fund', {});
console.log('  summary:', JSON.stringify(rf.summary));
console.log('  明细:', rf.items.map((i) => `${i.name} → nav=${i.nav ?? '(未取到)'}`).join(', ') || '(空)');
console.log(`  净值 ${before.fundNav} → ${fund.nav}`);
console.log(`  份额 ${before.fundQty} → ${fund.quantity}（定投已补算 ${fund.dcaCount} 笔）`);
console.log(`  hidden 仍为 ${fund.hidden}`);

console.log('\n=== 加密货币板块（屏蔽状态）===');
const rc = await runUpdate(state, 'crypto', {});
console.log('  summary:', JSON.stringify(rc.summary));
console.log('  明细:', rc.items.map((i) => `${i.name} → $${i.price ?? '(未取到)'}`).join(', ') || '(空)');
console.log(`  价格 $${before.coinPrice} → $${coin.priceUsd}`);
console.log(`  hidden 仍为 ${coin.hidden}`);

const ok =
  coin.priceUsd > 0 && // 屏蔽的币照常取到价
  coin.hidden === true && // 屏蔽标记没被改
  fund.hidden === true &&
  (fund.nav > 0 || rf.errors.length > 0); // 净值取到（或确实取不到，网络原因）

console.log(`\n结论：${ok ? '✓ 屏蔽项照常更新，屏蔽标记不受影响' : '✗ 不符合预期'}`);
console.log(`  （基金定投是否补算：${fund.dcaCount > 0 ? '是' : '否 —— 若为否则看下一行的原因'}）`);
if (rf.errors.length) console.log('  基金错误:', JSON.stringify(rf.errors));
if (rc.errors.length) console.log('  加密错误:', JSON.stringify(rc.errors));
process.exit(ok ? 0 : 1);
