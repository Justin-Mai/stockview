/**
 * 可读性审计：用真实浏览器测量页面上文字的对比度（WCAG 2.1）。
 *
 * 做法：对一组关键选择器取 getComputedStyle，向上寻找第一个不透明背景作为底色，
 * 计算对比度并对照 WCAG 阈值：
 *   - 普通文字（< 18.66px / 非粗体）需 ≥ 4.5:1
 *   - 大号文字（≥ 18.66px 或 ≥ 14px 粗体）需 ≥ 3:1
 *
 * 用法：
 *   node scripts/contrast-check.mjs            # 标准模式
 *   node scripts/contrast-check.mjs --hc       # 顺带测高对比度模式
 * 需要本地服务已在 3939 端口运行。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 3939;
})();
const APP = `http://127.0.0.1:${argPort}`;
const CDP_PORT = argPort + 3000;
const withHc = process.argv.includes('--hc');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); } }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '执行出错');
    return r.result?.value;
  }
  async shot(file, width = 1680, height = 1150) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(ROOT, '.shots', file), Buffer.from(data, 'base64'));
  }
}

/** 在页面里跑的测量逻辑 */
const MEASURE = (selectors) => `
(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1,l2), lo = Math.min(l1,l2); return (hi + 0.05) / (lo + 0.05); };

  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a >= 0.95) return c;
      node = node.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 11, g: 10, b: 9, a: 1 };
  };

  const out = [];
  for (const sel of ${JSON.stringify(selectors)}) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) { out.push({ sel, missing: true }); continue; }
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 18.66 || (size >= 14 && weight >= 700);
    const cr = ratio(fg, bg);
    out.push({
      sel,
      text: (el.textContent || '').trim().slice(0, 14),
      size: Math.round(size * 10) / 10,
      weight,
      fg: cs.color,
      cr: Math.round(cr * 100) / 100,
      need: large ? 3 : 4.5,
      pass: cr >= (large ? 3 : 4.5),
    });
  }
  return out;
})()
`;

async function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    try { await fs.access(p); return p; } catch { /* next */ }
  }
  throw new Error('未找到 Chrome / Edge');
}

const SEL = [
  ['总览 · 大盘数字', '.hero-value'],
  ['总览 · 统计标签', '.hero-sub .stat > span'],
  ['总览 · 统计数值', '.hero-sub .stat b'],
  ['总览 · 侧栏小字', '.side-block small'],
  ['总览 · 配置图例', '.legend-item'],
  ['总览 · 卡片脚注', '.card-foot'],
  ['总览 · 流水标签', '.log-row .tag'],
  ['总览 · 流水时间', '.log-row time'],
  ['股票 · 表头', 'thead th'],
  ['股票 · 单元格', 'tbody td'],
  ['股票 · 标的副标题', '.who span'],
  ['股票 · 面板标签', '.pstat > span'],
  ['股票 · 面板数值', '.pstat b'],
  ['股票 · 亏损数值', '.pstat b .down, .pstat b .up'],
  ['侧脊 · 键值标签', '.kv span'],
  ['侧脊 · 功能链接', '.linky'],
  ['表格 · 说明文字', '.panel > p.dim'],
];

await fs.mkdir(path.join(ROOT, '.shots'), { recursive: true });
const browser = await findBrowser();
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(ROOT, '.shots', 'profile-contrast')}`,
  '--window-size=1680,1150', 'about:blank',
], { stdio: 'ignore' });

let cdp;
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = (await res.json()).find((t) => t.type === 'page');
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((ok, bad) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', bad, { once: true }); });
      cdp = new CDP(ws);
      break;
    }
  } catch { /* retry */ }
  await sleep(400);
}
if (!cdp) { child.kill(); throw new Error('无法连接 CDP'); }

let failed = 0;
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(3500);

  const rounds = withHc ? [['标准模式', false], ['高对比度模式', true]] : [['标准模式', false]];
  for (const [label, hc] of rounds) {
    await cdp.evaluate(`document.documentElement.classList.toggle('hc', ${hc})`);
    await cdp.evaluate(`document.querySelector('.nav-item[data-tab="stock"]').click()`);
    await sleep(700);
    const rows = await cdp.evaluate(MEASURE(SEL.map((s) => s[1])));
    console.log(`\n===== ${label} =====`);
    console.log('  ' + '元素'.padEnd(18) + '字号'.padStart(6) + '对比度'.padStart(9) + '要求'.padStart(7) + '  结果');
    SEL.forEach(([name], i) => {
      const r = rows[i];
      if (!r || r.missing) { console.log(`  ${name.padEnd(16)}  —    （未找到元素）`); return; }
      const bad = !r.pass;
      if (bad) failed += 1;
      console.log(
        `  ${name.padEnd(16)}${String(r.size).padStart(6)}px${String(r.cr).padStart(8)}:1${String(r.need).padStart(6)}:1  ${bad ? '✗ 不达标' : '✓'}`,
      );
    });
    await cdp.evaluate(`document.querySelector('.nav-item[data-tab="overview"]').click()`);
    await sleep(700);
    await cdp.shot(hc ? 'contrast-hc.png' : 'contrast-std.png');
  }
} finally {
  console.log(failed === 0 ? '\n✓ 全部达标' : `\n✗ 共 ${failed} 项不达标`);
  try { await cdp?.send('Browser.close'); } catch { /* 忽略 */ }
  child.kill();
  process.exit(failed ? 1 : 0);
}
