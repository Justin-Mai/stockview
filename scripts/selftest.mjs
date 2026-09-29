/**
 * 端到端自检：真实行情 → 新增资产 → 执行更新 → 校验定投补算与估值。
 * 运行：node scripts/selftest.mjs
 */
import { load, save, emptyState } from '../server/store.js';
import { addAsset, runUpdate, computeState, updateAsset } from '../server/portfolio.js';
import * as util from '../server/util.js';

const log = (...a) => console.log(...a);
const line = (t) => log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

const state = emptyState();
// 先刷新汇率，加密货币成本折算需要
const cg = await import('../server/providers/crypto.js');
state.meta.usdCny = await cg.getUsdCny();
log('USD/CNY =', state.meta.usdCny);

line('1. 新增资产');
addAsset(state, 'stock', { code: '600519', name: '贵州茅台', quantity: 100, costPrice: 1180.5 });
addAsset(state, 'stock', { code: '000858', name: '五粮液', quantity: 300, costPrice: 142.3 });
const f1 = addAsset(state, 'fund', {
  code: '110022',
  name: '易方达消费行业股票',
  quantity: 1000,
  costPrice: 2.5,
  dca: { enabled: true, amount: 100, startDate: '2026-09-01' },
});
const f2 = addAsset(state, 'fund', {
  code: '161725',
  name: '招商中证白酒指数A',
  quantity: 5000,
  costPrice: 0.55,
  dca: { enabled: true, amount: 50, startDate: '2026-09-15' },
});
addAsset(state, 'crypto', { code: 'bitcoin', name: '比特币', symbol: 'BTC', quantity: 0.25, costPrice: 62000, currency: 'USD' });
addAsset(state, 'crypto', { code: 'ethereum', name: '以太坊', symbol: 'ETH', quantity: 3, costPrice: 2400, currency: 'USD' });
log('资产：股票 2、基金 2、加密货币 2');

line('2. 执行更新（含按交易日补算定投）');
for (const scope of ['stock', 'fund', 'crypto']) {
  const t0 = Date.now();
  const report = await runUpdate(state, scope);
  log(`\n[${report.scope}] 用时 ${Date.now() - t0}ms  summary=${JSON.stringify(report.summary)}`);
  for (const it of report.items) {
    const bits = [`${it.name}(${it.code || it.coinId || it.symbol})`];
    if (it.error) bits.push(`❌ ${it.error}`);
    else {
      if (it.price !== undefined) bits.push(`价 ${it.price}`);
      if (it.nav !== undefined) bits.push(`净值 ${it.nav}@${it.navDate}`);
      if (it.change !== undefined) bits.push(`自上次更新 ${it.change >= 0 ? '+' : ''}${it.change} (${it.changePct}%)`);
      if (it.dca) bits.push(`定投 补${it.dca.applied}笔 ¥${it.dca.invested} +${util.round(it.dca.units, 4)}份 待${it.dca.pending}日`);
      if (it.unitsBefore !== undefined) bits.push(`份额 ${it.unitsBefore}→${it.unitsAfter}`);
    }
    log('   •', bits.join(' | '));
  }
  if (report.errors.length) log('   errors:', JSON.stringify(report.errors, null, 1));
}

line('3. 重复更新（幂等性校验：不应重复扣定投）');
const before = { qty: state.funds.map((f) => f.quantity), cost: state.funds.map((f) => f.costAmount), count: state.funds.map((f) => f.dcaCount) };
for (const scope of ['stock', 'fund', 'crypto']) await runUpdate(state, scope);
const after = { qty: state.funds.map((f) => f.quantity), cost: state.funds.map((f) => f.costAmount), count: state.funds.map((f) => f.dcaCount) };
log('第二次更新前后基金份额/成本/定投笔数是否变化：', JSON.stringify(before) !== JSON.stringify(after) ? '❌ 变化了（幂等失败）' : '✅ 完全一致（幂等）');

line('4. 修改资产');
updateAsset(state, 'fund', f2.id, { quantity: 6000, costAmount: 3300, dca: { enabled: true, amount: 80 } });
log('修改后 161725：份额', state.funds[1].quantity, '总成本', state.funds[1].costAmount, '日定投', state.funds[1].dca.amount);

line('5. 估值快照');
const snap = await computeState(state);
log('总计：', JSON.stringify(snap.computed.totals));
log('分类：', JSON.stringify(snap.computed.byScope));
log('定投：', JSON.stringify(snap.computed.dca));
log('\n持仓明细：');
for (const r of [...snap.stocks, ...snap.funds, ...snap.crypto]) {
  log(
    ` ${r.scope.padEnd(6)} ${(r.name || '').padEnd(12)} 数量 ${String(r.quantity).padEnd(12)} 均价 ${String(r.avgCost).padEnd(10)} 现价 ${String(r.price).padEnd(12)} 市值 ${String(r.marketValue).padEnd(12)} 盈亏 ${r.pnl} (${r.pnlPct}%) 权重 ${r.weight}%`,
  );
}
log('\n最近日志：');
for (const l of snap.computed.logs.slice(0, 10)) log(` [${l.kind}] ${l.text}`);

await save(state);
log('\n已写入 data/portfolio.json');
