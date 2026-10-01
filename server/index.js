/**
 * 本地 HTTP 服务：既提供前端静态页面，也提供 REST API。
 * 零第三方依赖，只用 node:http / node:fs，双击 启动.bat 即可运行。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { load, mutate, paths, emptyState, backupNow, normalizeState } from './store.js';
import { buildDemoState } from './seed.js';
import * as pf from './portfolio.js';
import * as cn from './providers/cn.js';
import * as crypto from './providers/crypto.js';
import { addAsset, deleteAsset, updateAsset, primeAsset, reorderAssets, setAssetHidden } from './portfolio.js';
import { beginTask, currentTask, endTask, reportProgress } from './tasks.js';
import { nowStamp } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(path.resolve(__dirname, '..'), 'web');
const STARTED_AT = new Date().toISOString();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------- 基础工具 */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, ...data });
}

function fail(res, err, status = 400) {
  const message = typeof err === 'string' ? err : err?.message || '未知错误';
  if (status >= 500) console.error('[error]', err);
  sendJson(res, status, { ok: false, error: message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/* -------------------------------------------------------------- API 路由 */

/** 更新任务的取消令牌：同一时刻只有一个长任务，模块级变量即可 */
let updateAbort = null;

/**
 * 把「更新前读到的那份 state」里变化过的行情字段，合并回「刚重新读出来的 state」。
 *
 * 为什么要这么绕：更新行情要联网几十秒，早期版本把整个联网过程放在 store 的
 * mutate() 事务里，而 store 用**一条串行队列**同时串行化读和写 —— 于是更新期间
 * `GET /api/state` 会被堵住十几秒（前端遮罩上的进度条也因此卡在第 0 步不动）。
 *
 * 现在改成：先在事务外读一份快照 → 在快照上跑更新 → 再用一次很短的 mutate
 * 把结果落盘。合并时只搬「行情/统计」字段，不整对象覆盖；
 * 用户在更新期间改过的数量、成本、备注因此不会被覆盖掉。
 */
const MERGE_FIELDS = {
  stock: ['price', 'priceDate', 'prevClose', 'changePercent', 'lastQuoteDate', 'baselinePrice', 'baselineDate', 'lastUpdate', 'history'],
  fund: ['nav', 'navDate', 'accNav', 'dailyReturn', 'baselinePrice', 'baselineDate', 'lastUpdate', 'history', 'quantity', 'costAmount', 'costPrice', 'lastDcaDate', 'dcaCount', 'dcaInvested', 'dcaUnits', 'missedDates'],
  crypto: ['price', 'priceCny', 'priceUsd', 'change24h', 'priceSource', 'baselinePrice', 'baselineDate', 'lastUpdate', 'history'],
};

function mergeQuotes(live, source, scope) {
  const key = scope === 'stock' ? 'stocks' : scope === 'fund' ? 'funds' : 'crypto';
  const byId = new Map((source[key] || []).map((a) => [a.id, a]));
  let n = 0;
  for (const asset of live[key] || []) {
    const src = byId.get(asset.id);
    if (!src) continue; // 更新期间被删掉了：保持删除
    // 更新期间被屏蔽 / 取消屏蔽：以用户最新的选择为准，不要用旧快照覆盖回去
    if (Boolean(src.hidden) !== Boolean(asset.hidden)) continue;
    for (const f of MERGE_FIELDS[scope] || []) {
      if (src[f] === undefined) continue;
      asset[f] = src[f];
    }
    n += 1;
  }
  return n;
}

/** 统一快照：组合数据 + 服务端信息（数据文件、端口、Node 版本、行情源健康度） */
async function snapshot(state) {
  const snap = await pf.computeState(state);
  snap.computed.server = {
    dataFile: paths.DATA_FILE,
    port: server.address()?.port ?? PORT_BASE,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    startedAt: STARTED_AT,
    crypto: crypto.sourceStatus(),
    fx: crypto.fxStatus(),
  };
  return snap;
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api/, '') || '/';

  if (req.method === 'GET' && route === '/health') {
    return ok(res, { alive: true, pid: process.pid, dataFile: paths.DATA_FILE });
  }

  // 完整组合快照（屏蔽项不计入任何合计，但仍会出现在列表里并带标注）
  if (req.method === 'GET' && route === '/state') {
    const state = await load();
    return ok(res, { state: await snapshot(state) });
  }

  // 新增资产
  if (req.method === 'POST' && route === '/assets') {
    const body = await readBody(req);
    const { scope, data } = body;
    const { state, result } = await mutate(async (s) => {
      // 加密货币的人民币成本要用汇率折算，先把汇率刷成本次的真实值，
      // 否则会退回硬编码的 7.1，导致成本高估、盈亏低估（成本入库后不会再改）
      if (scope === 'crypto') {
        try {
          const rate = await crypto.getUsdCny();
          if (rate) {
            s.meta.usdCny = rate;
            s.meta.usdCnyAt = nowStamp();
          }
        } catch {
          /* 沿用已有汇率 */
        }
      }
      const asset = addAsset(s, scope, data || {});
      await primeAsset(s, scope, asset); // 立刻取一次行情，避免新记录显示成本价
      return asset;
    });
    return ok(res, { asset: result, state: await snapshot(state), message: `已添加 ${result.name}` });
  }

  // 修改资产
  if ((req.method === 'PATCH' || req.method === 'PUT') && route === '/assets') {
    const body = await readBody(req);
    const { scope, id, data } = body;
    const { state, result } = await mutate(async (s) => {
      const { asset, codeChanged } = updateAsset(s, scope, id, data || {});
      // 改了代码等于换了一只标的：清空旧行情后立刻重新取价，否则会拿着 A 的市价显示 B
      if (codeChanged) await primeAsset(s, scope, asset);
      return { asset, codeChanged };
    });
    return ok(res, {
      asset: result.asset,
      state: await snapshot(state),
      refreshed: result.codeChanged,
      message: result.codeChanged ? `已保存 ${result.asset.name}，并重新获取行情` : `已保存 ${result.asset.name}`,
    });
  }

  // 删除资产
  if (req.method === 'DELETE' && route === '/assets') {
    const scope = url.searchParams.get('scope');
    const id = url.searchParams.get('id');
    const { state, result } = await mutate((s) => deleteAsset(s, scope, id));
    return ok(res, { asset: result, state: await snapshot(state), message: `已删除 ${result.name}` });
  }

  // 屏蔽 / 取消屏蔽某项资产（只影响合计口径，不删除、不清空任何数据）
  if (req.method === 'POST' && route === '/assets/hidden') {
    const body = await readBody(req);
    const { scope, id, hidden } = body;
    const { state, result } = await mutate((s) => setAssetHidden(s, scope, id, hidden !== false));
    const isHidden = Boolean(result.hidden);
    return ok(res, {
      asset: result,
      state: await snapshot(state),
      hidden: isHidden,
      // 屏蔽只是把这一项移出合计，持仓与行情都原样留着，
      // 所以两个方向都不该提示「去更新行情」——恢复是即时的。
      message: isHidden
        ? `已屏蔽 ${result.name}，暂不计入合计（数据原样保留）`
        : `已恢复 ${result.name}，持仓与行情原样还原`,
    });
  }

  // 执行更新（股票 / 基金 / 加密货币 / 全部）
  // 与「重建演示数据」一样开一个长任务，前端轮询 /api/task 显示「正在获取 XX 日线…」这类真实进度
  //
  // ⚠️ 联网过程**不放在 mutate 事务里**：store 的读写共用一条串行队列，
  // 早期版本更新 87 秒就把 /api/state 一起堵了 87 秒（遮罩上的进度条卡在第 0 步）。
  // 现在：事务外读快照 → 在快照上更新 → 一次短事务合并落盘。
  if (req.method === 'POST' && route === '/update') {
    const body = await readBody(req).catch(() => ({}));
    const scope = body.scope || 'all';
    const scopes = scope === 'all' ? ['stock', 'fund', 'crypto'] : [scope];
    const title = scope === 'all' ? '正在更新全部行情' : `正在更新${pf.SCOPE_LABEL[scope] || ''}行情`;
    if (updateAbort) throw Object.assign(new Error('已有一个更新任务在进行中'), { status: 409 });

    const ctrl = new AbortController();
    updateAbort = ctrl;
    const draft = await load();
    const total = scopes.reduce((n, sc) => n + pf.countAssets(draft, sc), 0);
    let step = 0;
    beginTask(title, total);
    const onProgress = (p) => {
      if (p && p.advance) step += 1;
      reportProgress({ step, total, label: p?.label });
    };

    let reports;
    try {
      reports = [];
      for (const sc of scopes) reports.push(await pf.runUpdate(draft, sc, { onProgress, signal: ctrl.signal }));
      if (total === 0) reportProgress({ step: 0, total: 0, label: '没有需要更新的持仓' });
      endTask();
    } catch (err) {
      endTask(err);
      // 中止：不落盘，也不推进 lastUpdate —— 下次更新仍以原基准计算
      if (err?.name === 'AbortError' || ctrl.signal.aborted) {
        return ok(res, { reports: [], aborted: true, state: await snapshot(await load()), message: '更新已中止' });
      }
      throw err;
    } finally {
      updateAbort = null;
    }

    const { state } = await mutate((s) => {
      for (const rep of reports) mergeQuotes(s, draft, rep.scope);
      for (const sc of scopes) s.meta.lastUpdate[sc] = draft.meta.lastUpdate[sc] ?? s.meta.lastUpdate[sc];
      s.meta.quoteAt = draft.meta.quoteAt;
      if (draft.meta.usdCny) {
        s.meta.usdCny = draft.meta.usdCny;
        s.meta.usdCnyAt = draft.meta.usdCnyAt;
      }
      s.logs = draft.logs; // 更新过程写了多条流水（含定投明细），直接沿用
      return reports;
    });
    return ok(res, { reports, state: await snapshot(state) });
  }

  // 中止正在进行的更新（只有加密货币这类可中断的源会立刻生效）
  if (req.method === 'POST' && route === '/update/cancel') {
    if (!updateAbort) return ok(res, { cancelled: false, message: '当前没有进行中的更新' });
    updateAbort.abort(new Error('用户中止'));
    return ok(res, { cancelled: true, message: '已请求中止更新' });
  }

  // 新增资产前预览行情
  if (req.method === 'GET' && route === '/lookup') {
    const scope = url.searchParams.get('scope') || 'stock';
    const code = url.searchParams.get('code') || '';
    if (scope === 'crypto') {
      const coins = crypto.COMMON_COINS;
      const q = code.toLowerCase();
      const hit = coins.find((c) => c.id === q || c.symbol.toLowerCase() === q) || null;
      if (!hit) throw new Error('请从搜索下拉里选择币种');
      const prices = await crypto.getPrices([hit.id], { [hit.id]: hit.symbol });
      const p = prices.get(hit.id);
      return ok(res, { asset: { code: hit.id, name: hit.name, symbol: hit.symbol, price: p?.priceUsd ?? null, priceCny: p?.priceCny ?? null, change24h: p?.change24h ?? null } });
    }
    const asset = await cn.lookupSymbol(scope, code);
    return ok(res, { asset: { ...asset, code, symbol: undefined } });
  }

  // 股票 / 基金搜索
  if (req.method === 'GET' && route === '/search') {
    const q = url.searchParams.get('q') || '';
    const scope = url.searchParams.get('scope') || 'stock';
    if (scope === 'crypto') {
      const kw = q.trim().toLowerCase();
      const hot = crypto.COMMON_COINS.filter(
        (c) => !kw || c.id.includes(kw) || c.symbol.toLowerCase().includes(kw) || c.name.includes(q.trim()),
      ).map((c) => ({ code: c.id, name: c.name, symbol: c.symbol, assetType: 'crypto' }));
      if (hot.length || !kw) return ok(res, { results: hot.slice(0, 15) });
      const remote = await crypto.searchCoins(q);
      return ok(res, { results: remote.map((c) => ({ code: c.id, name: c.name, symbol: c.symbol, assetType: 'crypto', rank: c.rank })) });
    }
    const results = await cn.searchSymbol(q);
    return ok(res, { results });
  }

  // 热门币种
  if (req.method === 'GET' && route === '/coins') {
    return ok(res, { results: crypto.COMMON_COINS });
  }

  // 重置数据：清空 / 重建演示数据
  // 重建演示要联网抓行情（数秒），因此开一个任务并实时汇报进度，前端轮询 /api/task 显示
  if (req.method === 'POST' && route === '/reset') {
    const body = await readBody(req).catch(() => ({}));
    const mode = body.mode === 'demo' ? 'demo' : 'empty';
    const isDemo = mode === 'demo';
    const backup = await backupNow(isDemo ? 'before-demo' : 'before-clear'); // 破坏性操作前先留一份
    if (isDemo) beginTask('正在重建演示数据');

    let state;
    try {
      ({ state } = await mutate(async (s) => {
        const next = isDemo ? await buildDemoState({ onProgress: reportProgress }) : emptyState();
        for (const k of Object.keys(s)) delete s[k];
        Object.assign(s, next);
        return next;
      }));
      if (isDemo) endTask();
    } catch (err) {
      if (isDemo) endTask(err);
      throw err;
    }

    return ok(res, {
      state: await snapshot(state),
      backup: backup ? path.basename(backup) : null,
      message: isDemo ? '已重建演示数据' : '已清空全部数据',
    });
  }

  // 拖动排序后保存顺序
  if (req.method === 'POST' && route === '/order') {
    const body = await readBody(req);
    const { scope, ids } = body;
    const { state, result } = await mutate((s) => reorderAssets(s, scope, ids || []));
    return ok(res, { count: result, state: await snapshot(state), message: '排序已保存' });
  }

  // 导出：直接下载数据文件（浏览器会按 Content-Disposition 存成文件）
  if (req.method === 'GET' && route === '/export') {
    const state = await load();
    const body = JSON.stringify(state, null, 2);
    const stamp = new Date().toISOString().slice(0, 16).replaceAll(':', '-');
    const ascii = `stockview-${stamp}.json`;
    const zh = `股票账本-${stamp}.json`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      // 同时给 ASCII 与 UTF-8 文件名：老浏览器用前者，现代浏览器优先用后者
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(zh)}`,
      'cache-control': 'no-store',
    });
    return res.end(body);
  }

  // 导入：用上传的 JSON 覆盖全部数据（写之前自动备份现有数据）
  if (req.method === 'POST' && route === '/import') {
    const body = await readBody(req);
    const payload = body?.data ?? body?.state ?? body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('文件内容不是一个 JSON 对象');
    }
    const hasAny = ['stocks', 'funds', 'crypto'].some((k) => Array.isArray(payload[k]));
    if (!hasAny) throw new Error('文件里没有 stocks / funds / crypto 字段，可能不是本程序导出的备份');

    const next = normalizeState(payload);
    const backup = await backupNow('before-import');
    const { state } = await mutate(async (s) => {
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, next);
      return next;
    });
    const summary = `股票 ${next.stocks.length} · 基金 ${next.funds.length} · 加密货币 ${next.crypto.length}`;
    return ok(res, {
      state: await snapshot(state),
      backup: backup ? path.basename(backup) : null,
      message: `已导入数据（${summary}）`,
    });
  }

  // 当前长任务进度（前端轮询）
  if (req.method === 'GET' && route === '/task') {
    return ok(res, { task: currentTask() });
  }

  // 交易日历（给前端展示「今天是否交易日」）
  if (req.method === 'GET' && route === '/calendar') {
    const date = url.searchParams.get('date');
    return ok(res, { isTradingDay: await cn.isTradingDay(date || undefined) });
  }

  return sendJson(res, 404, { ok: false, error: `未知接口 ${url.pathname}` });
}

/* -------------------------------------------------------------- 静态资源 */

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    return res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 not found');
  }
}

/* ------------------------------------------------------------------ 启动 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    fail(res, err, err?.status || 400);
  }
});

const PORT_BASE = Number(process.env.STOCKVIEW_PORT || 3939);
const HOST = '127.0.0.1';
const shouldOpen = process.argv.includes('--open');

// 'listening' 只注册一次：失败重试时不会再残留回调，端口以 server.address() 的真实值为准
server.once('listening', () => {
  const port = server.address().port;
  const url = `http://${HOST}:${port}`;
  console.log('');
  console.log('  股票账本已启动');
  console.log(`  ➜  ${url}`);
  console.log(`  ➜  数据文件：${paths.DATA_FILE}`);
  if (port !== PORT_BASE) {
    console.log(`  ➜  提示：${PORT_BASE} 端口已被占用，已自动改用 ${port}`);
  }
  console.log('  关闭此窗口即可停止服务');
  console.log('');
  if (shouldOpen) openBrowser(url);
});

function listen(port, attempt = 0) {
  const onError = (err) => {
    server.removeListener('error', onError);
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, HOST);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
    else if (process.platform === 'darwin') execFile('open', [url]);
    else execFile('xdg-open', [url]);
  } catch {
    /* 打不开浏览器不影响服务运行 */
  }
}

listen(PORT_BASE);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在退出…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
