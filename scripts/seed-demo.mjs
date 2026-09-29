/** 重新生成演示数据：node scripts/seed-demo.mjs */
import { buildDemoState } from '../server/seed.js';
import { save, paths } from '../server/store.js';

const t0 = Date.now();
const state = await buildDemoState();
await save(state);
console.log(`演示数据已生成（${Date.now() - t0}ms）`);
console.log(`  股票 ${state.stocks.length} / 基金 ${state.funds.length} / 加密货币 ${state.crypto.length}`);
console.log(`  上次更新日期：${JSON.stringify(state.meta.lastUpdate)}`);
console.log(`  数据文件：${paths.DATA_FILE}`);
