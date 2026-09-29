/**
 * 真实浏览器交互自检（可选，开发用）。
 *
 * 用 Chrome 的 DevTools Protocol 驱动无头浏览器，逐个板块截图，
 * 并模拟「打开新增抽屉 → 填写表单 → 点击更新」等交互，确认前端无运行时错误。
 *
 * 用法：
 *   node scripts/uicheck.mjs               # 需要本地服务已在 3939 端口运行
 *   node scripts/uicheck.mjs --port 3940
 * 截图输出到 .shots/
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots');

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 3939;
})();
const APP = `http://127.0.0.1:${argPort}`;
const CDP_PORT = argPort + 1000;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

async function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('未找到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- 极简 CDP 客户端 */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.logs.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push(`[EXCEPTION] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面执行出错');
    return r.result?.value;
  }

  async shot(file, { width = 1680, height = 1150 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(320);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, file), Buffer.from(data, 'base64'));
  }
}

async function connect() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  return new CDP(ws);
}

/* ------------------------------------------------------------------ 主流程 */

await fs.mkdir(OUT, { recursive: true });
const browser = await findBrowser();
console.log('浏览器:', browser);

const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(ROOT, '.shots', 'profile')}`,
    '--window-size=1680,1150',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

let cdp;
for (let i = 0; i < 40; i += 1) {
  try {
    cdp = await connect();
    break;
  } catch {
    await sleep(400);
  }
}
if (!cdp) {
  child.kill();
  throw new Error('无法连接 Chrome DevTools Protocol');
}

const results = [];
const errors = [];

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(3500);

  // 1. 四个板块
  for (const t of ['overview', 'stock', 'fund', 'crypto']) {
    await cdp.evaluate(`document.querySelector('.nav-item[data-tab="${t}"]').click()`);
    await sleep(900);
    await cdp.shot(`ui-${t}.png`);
    const rows = await cdp.evaluate(`document.querySelectorAll('#view-${t} tbody tr').length`);
    results.push(`板块 ${t} 渲染完成，表格行数 ${rows}`);
  }

  // 2. 新增抽屉（基金：验证搜索 + 定投表单）
  await cdp.evaluate(`document.querySelector('.nav-item[data-tab="fund"]').click()`);
  await sleep(500);
  await cdp.evaluate(`document.querySelector('[data-add="fund"]').click()`);
  await sleep(900);
  const drawerVisible = await cdp.evaluate(`!document.querySelector('#drawer').hidden`);
  await cdp.shot('ui-drawer-fund.png');
  results.push(`基金抽屉打开：${drawerVisible}`);

  // 模拟搜索输入 + 选择第一个联想结果
  await cdp.evaluate(`
    (() => {
      const el = document.querySelector('#f_code');
      el.value = '110022';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(2200);
  const suggestCount = await cdp.evaluate(`document.querySelectorAll('#suggest div[data-code]').length`);
  if (suggestCount > 0) {
    await cdp.evaluate(`document.querySelector('#suggest div[data-code]').click()`);
    await sleep(1800);
  }
  await cdp.shot('ui-drawer-fund-filled.png');
  const previewText = await cdp.evaluate(`document.querySelector('#preview').innerText.replace(/\\n/g,' | ')`);
  results.push(`搜索联想命中 ${suggestCount} 条；预览：${previewText}`);
  await cdp.evaluate(`document.querySelector('#drawerCancel').click()`);
  await sleep(400);

  // 3. 修改抽屉
  await cdp.evaluate(`document.querySelectorAll('#view-fund tbody tr [data-edit]')[0].click()`);
  await sleep(900);
  const editFilled = await cdp.evaluate(`document.querySelector('#f_quantity').value + ' / ' + document.querySelector('#f_code').value`);
  await cdp.shot('ui-drawer-edit.png');
  results.push(`修改抽屉回填：${editFilled}`);
  await cdp.evaluate(`document.querySelector('#drawerCancel').click()`);
  await sleep(300);

  // 4. 点击「更新净值 & 定投」并等待结果提示
  await cdp.evaluate(`document.querySelector('#btnUpdate').click()`);
  await sleep(6000);
  const toastText = await cdp.evaluate(`[...document.querySelectorAll('.toast')].map(t=>t.innerText.replace(/\\n/g,' | ')).join('  ||  ')`);
  await cdp.shot('ui-after-fund-update.png');
  results.push(`基金更新提示：${toastText || '(无)'}`);

  // 5. 更新后的基金表 + 定投明细
  const dcaRow = await cdp.evaluate(`
    (() => {
      const tr = document.querySelectorAll('#view-fund tbody tr')[0];
      return tr ? tr.innerText.replace(/\\n/g,' | ') : '(无)';
    })()
  `);
  results.push(`更新后首行：${dcaRow}`);

  // 6. 加密货币更新
  await cdp.evaluate(`document.querySelector('.nav-item[data-tab="crypto"]').click()`);
  await sleep(500);
  await cdp.evaluate(`document.querySelector('#btnUpdate').click()`);
  await sleep(7000);
  await cdp.shot('ui-after-crypto-update.png');
  const cryptoTost = await cdp.evaluate(`[...document.querySelectorAll('.toast')].map(t=>t.innerText.replace(/\\n/g,' | ')).join('  ||  ')`);
  results.push(`加密货币更新提示：${cryptoTost || '(无)'}`);

  // 7. 总览
  await cdp.evaluate(`document.querySelector('.nav-item[data-tab="overview"]').click()`);
  await sleep(1200);
  await cdp.shot('ui-overview-after.png');

  const pageErrors = cdp.logs.filter((l) => /EXCEPTION|error/i.test(l));
  if (pageErrors.length) errors.push(...pageErrors);
} finally {
  console.log('\n===== 自检结果 =====');
  for (const r of results) console.log('✓', r);
  if (errors.length) {
    console.log('\n===== 页面报错 =====');
    for (const e of errors) console.log('✗', e);
  } else {
    console.log('\n✓ 页面无 JS 报错');
  }
  try {
    await cdp?.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  child.kill();
  process.exit(errors.length ? 1 : 0);
}
