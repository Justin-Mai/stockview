/* ============================================================
   股票账本 · 前端
   零依赖原生 ES 模块。所有数值计算都在服务端完成，这里只负责渲染与交互。
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------ 格式化 */

const nf = (dp) => ({ minimumFractionDigits: dp, maximumFractionDigits: dp });

const fmt = {
  money(n, dp = 2) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return `${v < 0 ? '-' : ''}¥${Math.abs(v).toLocaleString('zh-CN', nf(dp))}`;
  },
  num(n, dp = 2) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('zh-CN', nf(dp));
  },
  qty(n) {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const s = v.toLocaleString('zh-CN', nf(Math.abs(v) < 1 ? 4 : 2));
    return s;
  },
  price(n, dp = 4) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    const digits = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 3 : dp;
    return v.toLocaleString('zh-CN', nf(digits));
  },
  pct(n, dp = 2, plus = true) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return `${v > 0 && plus ? '+' : ''}${v.toFixed(dp)}%`;
  },
  signed(n, dp = 2) {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    return `${v > 0 ? '+' : ''}${v.toLocaleString('zh-CN', nf(dp))}`;
  },
  cls(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  },
  date(s) {
    return s ? String(s) : '—';
  },
  time(s) {
    return s ? String(s).slice(0, 16) : '—';
  },
};

/* ------------------------------------------------------------ 基础工具 */

const SCOPE_META = {
  overview: { title: '总览', en: 'Overview', eyebrow: '资金总账' },
  stock: { title: '股票', en: 'Stocks', eyebrow: '权益持仓' },
  fund: { title: '基金', en: 'Funds', eyebrow: '定投账页' },
  crypto: { title: '加密货币', en: 'Crypto', eyebrow: '数字资产' },
  settings: { title: '设置', en: 'Settings', eyebrow: '偏好与数据' },
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    throw new Error(`服务返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------------------------------------ 全局状态 */

let S = null; // 服务端快照
let tab = 'overview';
const flashQueue = new Map(); // id -> { dir, at }

/* ------------------------------------------------------------ 高对比度 */

const HC_KEY = 'stockview.contrast';

function applyContrast(on) {
  document.documentElement.classList.toggle('hc', on);
  try {
    localStorage.setItem(HC_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式下忽略 */
  }
  // 设置页里的开关状态需要跟着刷新
  if (S && tab === 'settings') render();
}

function initContrast() {
  let saved = null;
  try {
    saved = localStorage.getItem(HC_KEY);
  } catch {
    /* 忽略 */
  }
  // 未手动选择过时，跟随系统的「提高对比度」偏好
  const prefersMore = window.matchMedia?.('(prefers-contrast: more)').matches;
  applyContrast(saved === null ? Boolean(prefersMore) : saved === '1');
}

/* ------------------------------------------------------------ 加载遮罩 */

let busyTimer = null;

function showBusy(title, label) {
  $('#busyTitle').textContent = title;
  $('#busyLabel').textContent = label || '正在准备…';
  $('#busyFill').style.width = '4%';
  $('#busyMeta').textContent = '';
  $('#busy').hidden = false;
}

function updateBusy(task) {
  if (!task || task.idle) return;
  $('#busyLabel').textContent = task.label || '处理中…';
  const pct = task.total > 0 ? Math.round((task.step / task.total) * 100) : 0;
  $('#busyFill').style.width = `${Math.max(4, Math.min(100, pct))}%`;
  $('#busyMeta').textContent = `第 ${task.step} / ${task.total} 步 · 已用 ${(task.elapsedMs / 1000).toFixed(1)} 秒`;
}

function hideBusy() {
  $('#busy').hidden = true;
  stopBusyPolling();
}

function stopBusyPolling() {
  if (busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}

/** 显示遮罩并轮询服务端真实进度（而不是干转一个圈） */
async function startBusyPolling(title, firstLabel) {
  stopBusyPolling();
  showBusy(title, firstLabel);
  const poll = async () => {
    try {
      const { task } = await api('/api/task');
      updateBusy(task);
    } catch {
      /* 网络抖动忽略，下一次轮询再试 */
    }
  };
  await poll();
  busyTimer = setInterval(poll, 400);
}

/* ------------------------------------------------------------ 提示条 */

function toast(title, lines = [], kind = 'ok', ttl = 5200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${lines.length ? `<div class="lines">${lines.map((l) => esc(l)).join('<br>')}</div>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, ttl);
}

/* ------------------------------------------------------------ 数字滚动 */

function countUp(el, target, { dur = 950, dp = 2 } = {}) {
  const from = 0;
  const t0 = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    const v = from + (target - from) * ease(p);
    el.textContent = Math.abs(v).toLocaleString('zh-CN', nf(dp));
    if (p < 1) requestAnimationFrame(frame);
    else el.textContent = Math.abs(target).toLocaleString('zh-CN', nf(dp));
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------ 走势图 */

const PALETTE = ['#e8452c', '#c9a227', '#38a67b', '#ff7255', '#8d8478', '#b8842c', '#4ec296', '#a85f3c'];

function sparkline(points, { w = 90, h = 26 } = {}) {
  const vals = (points || []).map((p) => Number(p.close ?? p.nav ?? p.price)).filter(Number.isFinite);
  if (vals.length < 3) return '<span class="dim mono" style="font-size:11px">数据不足</span>';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(2)}`).join(' ');
  const rising = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" stroke="${rising ? '#ff7255' : '#4ec296'}" opacity=".9"/></svg>`;
}

/* ============================================================ 顶栏 */

function renderHead() {
  const m = SCOPE_META[tab];
  $('#eyebrow').textContent = m.eyebrow;
  $('#viewTitle').innerHTML = `<span>${m.title}</span><em>${m.en}</em>`;

  const btn = $('#btnUpdate');
  const isSettings = tab === 'settings';
  btn.style.display = isSettings ? 'none' : '';
  if (!isSettings) {
    btn.querySelector('.btn-label').textContent =
      tab === 'overview' ? '更新全部行情' : tab === 'stock' ? '更新股价' : tab === 'fund' ? '更新净值 & 定投' : '更新币价';
  }

  const lu = S?.meta?.lastUpdate || {};
  const info = $('#updateInfo');
  if (isSettings) {
    info.innerHTML = `组合共 <b>${S.computed.totals.count}</b> 项资产<br>行情时间 <b>${esc(fmt.time(S.computed.quoteAt))}</b>`;
  } else if (tab === 'overview') {
    info.innerHTML = `上次更新<br>股票 <b>${esc(fmt.date(lu.stock))}</b> · 基金 <b>${esc(fmt.date(lu.fund))}</b> · 加密 <b>${esc(fmt.date(lu.crypto))}</b>`;
  } else {
    const last = lu[tab];
    const pending = tab === 'fund' ? S.computed.dca.pendingDays : null;
    const extra =
      pending !== null
        ? pending > 0
          ? `<br><span class="warn">有 ${pending} 个交易日待补定投</span>`
          : '<br>定投已补至最新交易日'
        : '';
    info.innerHTML = `上次更新 <b>${esc(fmt.date(last))}</b><br>行情时间 <b>${esc(fmt.time(S.computed.quoteAt))}</b>${extra}`;
  }

  $('#quoteAt').textContent = fmt.time(S.computed.quoteAt);
  $('#usdCny').textContent = S.computed.usdCny ? Number(S.computed.usdCny).toFixed(4) : '—';
  $('#todayStr').textContent = S.computed.today;
}

/* ============================================================ 总览 */

function renderOverview() {
  const c = S.computed;
  const t = c.totals;
  const el = $('#view-overview');

  const alloc = c.allocation.filter((a) => a.value > 0);
  const ribbon = alloc.length
    ? alloc
        .slice(0, 14)
        .map((a, i) => {
          const color = PALETTE[i % PALETTE.length];
          const w = Math.max(a.weight, 1.2);
          return `<div class="ribbon-seg" style="flex:${w} 1 0;background:${color}" title="${esc(a.name)} ${fmt.money(a.value)} · ${a.weight}%">
            ${w > 7 ? `<em>${esc(a.code || a.name).slice(0, 10)} ${a.weight.toFixed(1)}%</em>` : ''}
          </div>`;
        })
        .join('')
    : '<div class="ribbon-seg" style="flex:1;background:var(--ink-4)"><em>暂无持仓</em></div>';

  const legend = alloc
    .slice(0, 10)
    .map((a, i) => {
      const color = PALETTE[i % PALETTE.length];
      return `<div class="legend-item"><i class="legend-dot" style="background:${color}"></i>${esc(a.name)} <b>${fmt.money(a.value)}</b> · ${a.weight}%</div>`;
    })
    .join('');

  const card = (key) => {
    const meta = SCOPE_META[key];
    const b = c.byScope[key];
    const list = key === 'stock' ? S.stocks : key === 'fund' ? S.funds : S.crypto;
    const pending = key === 'fund' ? c.dca.pendingDays : 0;
    return `<div class="card" data-goto="${key}">
      <div class="card-head"><b>${meta.title}</b><em>${list.length} 项 · ${t.marketValue > 0 ? ((b.marketValue / t.marketValue) * 100).toFixed(1) : '0.0'}%</em></div>
      <div class="card-value">${fmt.money(b.marketValue)}</div>
      <div class="card-foot">
        <span>盈亏 <b class="${fmt.cls(b.pnl)}">${fmt.signed(b.pnl)}</b> · <b class="${fmt.cls(b.pnl)}">${fmt.pct(b.pnlPct)}</b></span>
        <span>${key === 'fund' ? (pending > 0 ? `<b class="warn" style="color:var(--gold)">待定投 ${pending} 日</b>` : '定投已同步') : `成本 <b>${fmt.num(b.cost, 0)}</b>`}</span>
      </div>
    </div>`;
  };

  const logs = c.logs.slice(0, 14);
  const TAG = { add: '新增', edit: '修改', delete: '删除', update: '更新', dca: '定投' };

  el.innerHTML = `
    <section class="hero">
      <div class="hero-main">
        <p class="hero-label">Total Market Value · 总市值</p>
        <div class="hero-value"><span class="cur">¥</span><span id="heroInt">0</span><span class="cents" id="heroDec">.00</span></div>
        <div class="hero-sub">
          <div class="stat"><span>总成本</span><b>${fmt.money(t.cost)}</b></div>
          <div class="stat"><span>累计盈亏</span><b class="${fmt.cls(t.pnl)}">${fmt.signed(t.pnl)}</b><small class="${fmt.cls(t.pnl)}">${fmt.pct(t.pnlPct)}</small></div>
          <div class="stat"><span>持仓标的</span><b>${t.count}</b></div>
        </div>
      </div>
      <div class="hero-side">
        <div class="side-block">
          <span>自上次更新（价格贡献）</span>
          <b class="${fmt.cls(t.sinceValueCny)}">${fmt.signed(t.sinceValueCny)}</b>
          <small class="${fmt.cls(t.sincePct)}">${fmt.pct(t.sincePct)}</small>
        </div>
        <div class="side-block">
          <span>日定投合计 / 已定投</span>
          <b>${fmt.money(c.dca.dailyAmount)}</b>
          <small>${c.dca.enabledFunds} 只基金 · 累计 ${c.dca.totalCount} 笔 ${fmt.money(c.dca.totalInvested)}</small>
        </div>
        <div class="side-block">
          <span>USD / CNY</span>
          <b>${Number(c.usdCny).toFixed(4)}</b>
          <small>${esc(fmt.time(c.usdCnyAt))}</small>
        </div>
      </div>
    </section>

    <section class="ribbon-wrap">
      <div class="ribbon">${ribbon}</div>
      ${legend ? `<div class="ribbon-legend">${legend}</div>` : ''}
    </section>

    <section class="cards">${card('stock')}${card('fund')}${card('crypto')}</section>

    <section class="tape">
      <div class="tape-head"><h3>账目流水</h3><span>Activity Log</span></div>
      ${logs.length ? logs.map((l, i) => `
        <div class="log-row" style="animation-delay:${i * 26}ms">
          <time>${esc(fmt.time(l.ts))}</time>
          <span class="tag ${esc(l.kind)}">${TAG[l.kind] || l.kind}</span>
          <p>${esc(l.text)}</p>
        </div>`).join('') : '<p class="dim" style="padding:14px 0;font-size:12px">还没有操作记录</p>'}
    </section>
  `;

  // 数字滚动
  countUp($('#heroInt'), Math.floor(t.marketValue), { dur: 900, dp: 0 });
  $('#heroDec').textContent = `.${String(Math.round((t.marketValue % 1) * 100)).padStart(2, '0')}`;

  $$('.card', el).forEach((c2) => c2.addEventListener('click', () => switchTab(c2.dataset.goto)));
}

/* ============================================================ 表格 */

const COLUMNS = {
  stock: [
    { k: '标的', cls: 'l' },
    { k: '持股' }, { k: '成本价' }, { k: '现价' }, { k: '今日涨跌' },
    { k: '市值' }, { k: '浮动盈亏' }, { k: '收益率' }, { k: '自上次更新' },
    { k: '走势' }, { k: '操作', cls: 'l' },
  ],
  fund: [
    { k: '标的', cls: 'l' },
    { k: '持有份额' }, { k: '持仓均价' }, { k: '单位净值' }, { k: '日涨跌' },
    { k: '市值' }, { k: '浮动盈亏' }, { k: '收益率' }, { k: '日定投' }, { k: '已定投' },
    { k: '自上次更新' }, { k: '走势' }, { k: '操作', cls: 'l' },
  ],
  crypto: [
    { k: '标的', cls: 'l' },
    { k: '数量' }, { k: '成本价' }, { k: '现价' }, { k: '24h' },
    { k: '市值 (¥)' }, { k: '浮动盈亏' }, { k: '收益率' }, { k: '自上次更新' },
    { k: '操作', cls: 'l' },
  ],
};

function panelStats(key) {
  const b = S.computed.byScope[key];
  const lu = S.meta.lastUpdate[key];
  const rows = key === 'stock' ? S.stocks : key === 'fund' ? S.funds : S.crypto;
  const items = [
    ['市值', fmt.money(b.marketValue)],
    ['成本', fmt.money(b.cost)],
    ['浮动盈亏', `<span class="${fmt.cls(b.pnl)}">${fmt.signed(b.pnl)}</span> / <span class="${fmt.cls(b.pnlPct)}">${fmt.pct(b.pnlPct)}</span>`],
  ];
  if (key === 'fund') {
    items.push(['日定投合计', fmt.money(S.computed.dca.dailyAmount)]);
    items.push(['待执行交易日', S.computed.dca.pendingDays > 0 ? `<span style="color:var(--gold)">${S.computed.dca.pendingDays} 天</span>` : '已同步']);
    items.push(['累计定投', `${S.computed.dca.totalCount} 笔 · ${fmt.money(S.computed.dca.totalInvested)}`]);
  } else if (key === 'crypto') {
    items.push(['USD/CNY', Number(S.computed.usdCny).toFixed(4)]);
  } else {
    items.push(['自上次更新', `<span class="${fmt.cls(b.sinceValueCny)}">${fmt.signed(b.sinceValueCny)}</span>`]);
  }
  items.push(['上次更新', fmt.date(lu)]);
  return items.map(([k, v]) => `<div class="pstat"><span>${k}</span><b>${v}</b></div>`).join('');
}

function rowStock(r) {
  const dp = 4;
  return `<tr data-id="${esc(r.id)}">
    <td class="l"><div class="who"><b>${esc(r.name)}</b><span>${esc(r.code)}${r.note ? ` · ${esc(r.note)}` : ''}</span></div></td>
    <td>${fmt.qty(r.quantity)}</td>
    <td>${fmt.price(r.avgCost, dp)}</td>
    <td><b>${fmt.price(r.price, dp)}</b></td>
    <td class="${fmt.cls(r.dayChangePct)}">${fmt.pct(r.dayChangePct)}</td>
    <td>${fmt.money(r.marketValue)}</td>
    <td class="${fmt.cls(r.pnl)}">${fmt.signed(r.pnl)}</td>
    <td class="${fmt.cls(r.pnlPct)}">${fmt.pct(r.pnlPct)}</td>
    <td class="${fmt.cls(r.sinceChange)}">${fmt.signed(r.sinceChange, 3)}<br><span style="font-size:11px">${fmt.pct(r.sinceChangePct)}</span></td>
    <td>${sparkline(r.history)}</td>
    <td class="l"><div class="row-actions"><button class="linky" data-edit="${esc(r.id)}">修改</button><button class="linky danger" data-del="${esc(r.id)}">删除</button></div></td>
  </tr>`;
}

function rowFund(r) {
  const dcaOn = r.dca?.enabled && Number(r.dca.amount) > 0;
  const dcaCell = dcaOn
    ? `<span class="badge on">¥${fmt.num(r.dca.amount, 0)}/日</span>`
    : '<span class="badge">未开启</span>';
  const pending = r.pendingDays > 0 ? `<span class="badge wait">待 ${r.pendingDays} 日</span>` : '';
  return `<tr data-id="${esc(r.id)}">
    <td class="l"><div class="who"><b>${esc(r.name)}</b><span>${esc(r.code)}${dcaOn && r.lastDcaDate ? ` · 上次定投 ${esc(r.lastDcaDate)}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</span></div></td>
    <td>${fmt.qty(r.quantity)}</td>
    <td>${fmt.price(r.avgCost)}</td>
    <td><b>${fmt.price(r.nav)}</b><br><span style="font-size:11px" class="dim">${esc(fmt.date(r.navDate))}</span></td>
    <td class="${fmt.cls(r.dayChangePct)}">${fmt.pct(r.dayChangePct)}</td>
    <td>${fmt.money(r.marketValue)}</td>
    <td class="${fmt.cls(r.pnl)}">${fmt.signed(r.pnl)}</td>
    <td class="${fmt.cls(r.pnlPct)}">${fmt.pct(r.pnlPct)}</td>
    <td>${dcaCell}<br>${pending}</td>
    <td>${r.dcaCount > 0 ? `${r.dcaCount} 笔<br><span style="font-size:11px" class="dim">${fmt.money(r.dcaInvested)} · ${fmt.qty(r.dcaUnits)} 份</span>` : '<span class="dim">—</span>'}</td>
    <td class="${fmt.cls(r.sinceChange)}">${fmt.signed(r.sinceChange, 4)}<br><span style="font-size:11px">${fmt.pct(r.sinceChangePct)}</span></td>
    <td>${sparkline(r.history)}</td>
    <td class="l"><div class="row-actions"><button class="linky" data-edit="${esc(r.id)}">修改</button><button class="linky danger" data-del="${esc(r.id)}">删除</button></div></td>
  </tr>`;
}

function rowCrypto(r) {
  const cur = r.currency === 'CNY' ? '¥' : '$';
  return `<tr data-id="${esc(r.id)}">
    <td class="l"><div class="who"><b>${esc(r.name)}</b><span>${esc(r.symbol)} · ${esc(r.coinId)}${r.priceSource === 'okx' ? ' · <i class="flag">OKX</i>' : ''}${r.note ? ` · ${esc(r.note)}` : ''}</span></div></td>
    <td>${fmt.qty(r.quantity)}</td>
    <td>${cur}${fmt.price(r.costPrice, 2)}</td>
    <td><b>${cur}${fmt.price(r.nativePrice, 2)}</b>${r.currency === 'USD' && r.priceCny ? `<br><span style="font-size:11px" class="dim">¥${fmt.price(r.priceCny, 2)}</span>` : ''}</td>
    <td class="${fmt.cls(r.dayChangePct)}">${fmt.pct(r.dayChangePct)}</td>
    <td>${fmt.money(r.marketValue)}</td>
    <td class="${fmt.cls(r.pnl)}">${fmt.signed(r.pnl)}</td>
    <td class="${fmt.cls(r.pnlPct)}">${fmt.pct(r.pnlPct)}</td>
    <td class="${fmt.cls(r.sinceChange)}">${cur}${fmt.signed(r.sinceChange, 2)}<br><span style="font-size:11px">${fmt.pct(r.sinceChangePct)}</span></td>
    <td class="l"><div class="row-actions"><button class="linky" data-edit="${esc(r.id)}">修改</button><button class="linky danger" data-del="${esc(r.id)}">删除</button></div></td>
  </tr>`;
}

const ROW_FN = { stock: rowStock, fund: rowFund, crypto: rowCrypto };

function renderTable(key) {
  const rows = key === 'stock' ? S.stocks : key === 'fund' ? S.funds : S.crypto;
  const prefix =
    key === 'stock'
      ? '每行记录一只股票的持股与成本；「自上次更新」按上次更新时保存的价格计算变化。'
      : key === 'fund'
        ? '日定投在每次「更新净值」时，按 (上次定投日, 最新净值日] 之间每一个交易日的净值折算份额。'
        : '加密货币以 CoinGecko 计价（失败自动切 OKX）；成本按「计价货币」计入。';
  const cols = COLUMNS[key].map((c) => `<th class="${c.cls || ''}">${c.k}</th>`).join('');

  const body = rows.length
    ? rows.map((r, i) => ROW_FN[key](r).replace('<tr ', `<tr style="animation-delay:${Math.min(i * 28, 420)}ms" `)).join('')
    : '';

  return `
    <section class="panel">
      <div class="panel-head">
        <div class="panel-stats">${panelStats(key)}</div>
        <button class="btn-ghost" data-add="${key}">+ 添加${SCOPE_META[key].title}</button>
      </div>
      <p class="dim" style="font-size:12px;margin:-6px 0 16px;max-width:860px">${prefix}</p>
      <div class="table-wrap">
        <table>
          <thead><tr>${cols}</tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${rows.length ? '' : `<div class="empty"><div class="seal-ghost">空</div><p>还没有${SCOPE_META[key].title}记录</p><p class="small">点击右上角「+ 添加${SCOPE_META[key].title}」开始记账</p></div>`}
      </div>
    </section>`;
}

/* ============================================================ 设置 */

function renderSettings() {
  const sv = S.computed.server || {};
  const hc = document.documentElement.classList.contains('hc');
  const dca = S.computed.dca;
  const counts = { stock: S.stocks.length, fund: S.funds.length, crypto: S.crypto.length };
  const total = counts.stock + counts.fund + counts.crypto;
  const startedAt = sv.startedAt ? new Date(sv.startedAt).toLocaleString('sv-SE').slice(0, 19) : null;

  return `
    <section class="settings">
      <div class="set-section">
        <div class="set-head"><h3>显示</h3><em>Appearance</em></div>
        <div class="set-row">
          <div class="set-label">
            <b>高对比度</b>
            <span>把四级灰阶整体上抬（标签文字 7.5:1 → 11.4:1）并加粗账格线。低亮度环境、小屏或视力不佳时建议开启。未手动设置过时会自动跟随系统的「提高对比度」偏好。</span>
          </div>
          <div class="set-action">
            <label class="switch">
              <input type="checkbox" id="setContrast" ${hc ? 'checked' : ''} />
              <span class="track"></span>
              <b>${hc ? '已开启' : '已关闭'}</b>
            </label>
          </div>
        </div>
      </div>

      <div class="set-section">
        <div class="set-head"><h3>数据管理</h3><em>Data</em></div>
        <div class="set-row">
          <div class="set-label">
            <b>重建演示数据</b>
            <span>用 3 只股票 / 3 只基金（均开启日定投）/ 2 种加密货币覆盖当前数据，并把「上次更新」统一设为 5 个交易日之前 —— 这样点开「更新」就能直接看到行情变化与定投补算。需要联网抓行情，约 3–8 秒，过程中会显示实时进度。</span>
          </div>
          <div class="set-action"><button class="btn-ghost" id="setDemo">重建演示</button></div>
        </div>
        <div class="set-row">
          <div class="set-label">
            <b class="danger-text">清空全部数据</b>
            <span>删除所有持仓与流水记录，<b>不可撤销</b>。当前共 ${total} 项资产（股票 ${counts.stock} · 基金 ${counts.fund} · 加密货币 ${counts.crypto}）。执行前建议先备份数据文件。</span>
          </div>
          <div class="set-action"><button class="btn-danger" id="setClear">清空数据</button></div>
        </div>
      </div>

      <div class="set-section">
        <div class="set-head"><h3>运行环境</h3><em>Runtime</em></div>
        <dl class="set-about">
          <div><dt>数据文件</dt><dd class="mono">${esc(sv.dataFile || '—')}</dd></div>
          <div><dt>服务地址</dt><dd class="mono">http://127.0.0.1:${esc(String(sv.port ?? '—'))}</dd></div>
          <div><dt>Node 版本</dt><dd class="mono">${esc(sv.node || '—')}</dd></div>
          <div><dt>运行平台</dt><dd class="mono">${esc(sv.platform || '—')}</dd></div>
          <div><dt>服务启动于</dt><dd class="mono">${esc(startedAt || '—')}</dd></div>
          <div><dt>行情时间</dt><dd class="mono">${esc(fmt.time(S.computed.quoteAt))}</dd></div>
          <div><dt>USD / CNY</dt><dd class="mono">${Number(S.computed.usdCny).toFixed(4)}</dd></div>
          <div><dt>数据来源</dt><dd>A 股 / 基金：stock-sdk（腾讯财经 · 东方财富）<br />加密货币：CoinGecko（主）/ OKX（备）</dd></div>
          <div><dt>定投状态</dt><dd>${dca.enabledFunds} 只基金开启 · 合计 ${fmt.money(dca.dailyAmount)} / 交易日 · 累计 ${dca.totalCount} 笔 ${fmt.money(dca.totalInvested)}</dd></div>
        </dl>
        <p class="set-note">
          <b>备份</b>：复制 <b class="mono">data/portfolio.json</b> 即可；恢复时放回原位。
          写盘采用「临时文件 + 原子重命名」，文件损坏时会自动留档到 <b class="mono">data/backups/</b>。
        </p>
      </div>
    </section>`;
}

function wireSettings() {
  $('#setContrast')?.addEventListener('change', (e) => applyContrast(e.target.checked));
  $('#setDemo')?.addEventListener('click', rebuildDemo);
  $('#setClear')?.addEventListener('click', clearAll);
}

/** 重建演示数据：过程要联网数秒，显示遮罩 + 轮询真实进度 */
async function rebuildDemo() {
  if (!window.confirm('用演示数据覆盖当前数据？现有的持仓与流水会被替换掉。')) return;
  const btn = $('#setDemo');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '重建中…';
  }
  await startBusyPolling('正在重建演示数据', '正在连接行情源…');
  try {
    const res = await api('/api/reset', { method: 'POST', body: { mode: 'demo' } });
    hideBusy();
    applyState(res.state);
    toast(res.message, [
      '已生成 3 只股票 / 3 只基金（含日定投）/ 2 种加密货币',
      '「上次更新」已设为 5 个交易日之前，点「更新」即可看到行情变化与定投补算',
    ], 'ok', 8000);
  } catch (err) {
    hideBusy();
    toast('重建失败', [err.message], 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重建演示';
    }
  }
}

/** 清空数据：纯本地操作，瞬间完成 */
async function clearAll() {
  if (!window.confirm('确认清空全部持仓与记录？此操作不可撤销（建议先备份 data/portfolio.json）。')) return;
  const btn = $('#setClear');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '清空中…';
  }
  try {
    const res = await api('/api/reset', { method: 'POST', body: { mode: 'empty' } });
    applyState(res.state);
    toast(res.message, ['已删除全部持仓与流水记录'], 'warn');
  } catch (err) {
    toast('操作失败', [err.message], 'err');
  } finally {
    if (btn && document.contains(btn)) {
      btn.disabled = false;
      btn.textContent = '清空数据';
    }
  }
}

/* ============================================================ 渲染入口 */

function render() {
  if (!S) return;
  renderHead();
  const view = $(`#view-${tab}`);

  if (tab === 'settings') {
    view.innerHTML = renderSettings();
    wireSettings();
  } else if (tab === 'overview') {
    view.innerHTML = '';
    renderOverview();
  } else {
    view.innerHTML = renderTable(tab);
    view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openDrawer(tab, b.dataset.edit)));
    view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeAsset(tab, b.dataset.del)));
    view.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.add)));
  }

  // 更新后闪烁提示（只作用于当前可见视图，过期的条目自动丢弃）
  if (flashQueue.size) {
    const now = Date.now();
    for (const [id, entry] of [...flashQueue]) {
      const tr = view.querySelector(`tr[data-id="${id}"]`);
      if (tr) {
        tr.classList.add(entry.dir > 0 ? 'flash-up' : 'flash-down');
        flashQueue.delete(id);
      } else if (now - entry.at > 8000) {
        flashQueue.delete(id);
      }
    }
  }
}

function applyState(next) {
  S = next;
  render();
}

function switchTab(next) {
  if (!SCOPE_META[next]) next = 'overview';
  if (next === tab) return;
  tab = next;
  if (location.hash.slice(1) !== next) history.replaceState(null, '', `#${next}`);
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${next}`));
  $$('.nav-item').forEach((n) => n.classList.toggle('on', n.dataset.tab === next));
  // 重放进场动画
  const view = $(`#view-${next}`);
  view.style.animation = 'none';
  void view.offsetHeight;
  view.style.animation = '';
  render();
}

/* ============================================================ 抽屉表单 */

const drawer = {
  open: false,
  scope: 'stock',
  id: null,
  initial: {},
  preview: null,
};

/** 表单里显示的数值：去掉浮点尾数，避免出现 1343.09078085 这种难看的值 */
function numStr(n, dp = 4) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toFixed(dp)));
}

/** 数字输入框：只把真正改动过的字段提交给服务端 */
function field(label, name, opts = {}) {
  const { type = 'text', value = '', step, hint, placeholder, readonly } = opts;
  return `<div class="field">
    <label for="f_${name}">${label}</label>
    <input id="f_${name}" name="${name}" type="${type}" value="${esc(value)}"
      ${step ? `step="${step}"` : ''} ${placeholder ? `placeholder="${esc(placeholder)}"` : ''} ${readonly ? 'readonly' : ''} />
    ${hint ? `<span class="hint">${hint}</span>` : ''}
  </div>`;
}

function openDrawer(scope, id = null) {
  drawer.scope = scope;
  drawer.id = id;
  drawer.preview = null;
  const asset = id ? (scope === 'stock' ? S.stocks : scope === 'fund' ? S.funds : S.crypto).find((x) => x.id === id) : null;

  $('#drawerKind').textContent = id ? '修改记录' : '新增记录';
  $('#drawerTitle').textContent = SCOPE_META[scope].title;
  $('#drawerDelete').hidden = !id;

  const form = $('#drawerForm');
  let html = '';

  if (scope === 'stock' || scope === 'fund') {
    html += `<div class="field autocomplete">
      <label for="f_code">${scope === 'fund' ? '基金代码' : '股票代码'}</label>
      <input id="f_code" name="code" type="text" value="${esc(asset?.code || '')}" placeholder="输入代码或名称搜索，如 600519 / 茅台" autocomplete="off" />
      <div class="suggest" id="suggest" hidden></div>
      <span class="hint" id="codeHint">支持 A 股代码、基金代码、名称、拼音首字母</span>
    </div>`;
    html += field('名称', 'name', { value: asset?.name || '' });
    html += `<div class="field-row">
      ${field(scope === 'fund' ? '持有份额' : '持股数量', 'quantity', { type: 'number', step: 'any', value: asset ? numStr(asset.quantity, 4) : '', placeholder: scope === 'fund' ? '1000' : '100' })}
      ${field(scope === 'fund' ? '持仓成本价（单位净值）' : '成本价', 'costPrice', { type: 'number', step: 'any', value: asset ? numStr(asset.costPrice ?? asset.avgCost, 4) : '', placeholder: scope === 'fund' ? '2.5' : '1180.5' })}
    </div>`;
    if (scope === 'fund') {
      html += field('持仓总成本（¥）', 'costAmount', {
        type: 'number',
        step: 'any',
        value: asset ? numStr(asset.costAmount, 2) : '',
        hint: '定投会持续累加总成本。若只想改总成本，改这里即可（留空则按上面的成本价 × 份额计算）。',
      });
    }
    if (scope === 'fund') {
      const dca = asset?.dca || { enabled: false, amount: 100, startDate: S.computed.today };
      html += `<div class="field" style="border-top:1px solid var(--line);padding-top:20px">
        <label>日定投策略</label>
        <label class="switch"><input type="checkbox" name="dcaEnabled" ${dca.enabled ? 'checked' : ''}/><span class="track"></span><b>按交易日每日定投</b></label>
        <span class="hint">开启后，每次「更新净值」会把每个交易日的定投金额按当日单位净值折算成份额，并累加到持有份额与总成本。</span>
      </div>
      <div class="field-row">
        ${field('每期金额（¥）', 'dcaAmount', { type: 'number', step: 'any', value: String(dca.amount ?? 100) })}
        ${field('起始日期', 'dcaStartDate', { type: 'date', value: dca.startDate || S.computed.today })}
      </div>`;
    }
  } else {
    html += `<div class="field autocomplete">
      <label for="f_code">币种</label>
      <input id="f_code" name="code" type="text" value="${esc(asset?.coinId || '')}" placeholder="搜索币种，如 btc / 比特币" autocomplete="off" />
      <div class="suggest" id="suggest" hidden></div>
      <span class="hint" id="codeHint">数据来自 CoinGecko（主）/ OKX（备），币种 id 决定取价准确性</span>
    </div>`;
    html += `<div class="field-row">
      ${field('名称', 'name', { value: asset?.name || '' })}
      ${field('符号', 'symbol', { value: asset?.symbol || '', placeholder: 'BTC' })}
    </div>`;
    html += `<div class="field-row">
      ${field('持有数量', 'quantity', { type: 'number', step: 'any', value: asset ? numStr(asset.quantity, 4) : '', placeholder: '0.35' })}
      ${field('成本价', 'costPrice', { type: 'number', step: 'any', value: asset ? numStr(asset.costPrice, 2) : '', placeholder: '61200' })}
    </div>`;
    html += `<div class="field">
      <label for="f_currency">计价货币</label>
      <select id="f_currency" name="currency">
        <option value="USD" ${asset?.currency !== 'CNY' ? 'selected' : ''}>USD（美元）</option>
        <option value="CNY" ${asset?.currency === 'CNY' ? 'selected' : ''}>CNY（人民币）</option>
      </select>
      <span class="hint">总览与市值统一按人民币统计，汇率自动获取（当前 1 USD ≈ ${Number(S.computed.usdCny).toFixed(4)} CNY）。</span>
    </div>`;
  }

  html += field('备注', 'note', { value: asset?.note || '', placeholder: '可选，例如：券商账户 / 长期底仓' });
  html += `<div class="preview" id="preview"><div class="pr"><span>参考行情</span><b>填写代码后自动获取</b></div></div>`;

  form.innerHTML = html;
  drawer.initial = collect(form);
  drawer.open = true;
  $('#backdrop').hidden = false;
  $('#drawer').hidden = false;
  $('#drawerSubmit').textContent = id ? '保存修改' : '添加';
  $('#drawerDelete').hidden = !id;

  bindDrawer(scope, asset);
  setTimeout(() => $('#f_code')?.focus(), 60);
}

function collect(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function closeDrawer() {
  drawer.open = false;
  $('#backdrop').hidden = true;
  $('#drawer').hidden = true;
  $('#suggest').hidden = true;
}

function bindDrawer(scope, asset) {
  const form = $('#drawerForm');
  const codeInput = $('#f_code');

  // 搜索联想
  let timer = null;
  let sel = -1;
  codeInput?.addEventListener('input', () => {
    clearTimeout(timer);
    sel = -1;
    const q = codeInput.value.trim();
    if (q.length < 1) {
      $('#suggest').hidden = true;
      return;
    }
    timer = setTimeout(() => searchSuggest(scope, q), 280);
  });

  codeInput?.addEventListener('keydown', (e) => {
    const box = $('#suggest');
    if (box.hidden) return;
    const items = $$('div', box);
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      sel = (sel + 1) % items.length;
    } else if (e.key === 'ArrowUp') {
      sel = (sel - 1 + items.length) % items.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (items[sel] || items[0]).click();
      return;
    } else return;
    items.forEach((it, i) => it.classList.toggle('sel', i === sel));
    items[sel]?.scrollIntoView({ block: 'nearest' });
  });

  form.addEventListener('input', () => updatePreview(scope, asset));
  form.addEventListener('change', () => updatePreview(scope, asset));

  form.onsubmit = (e) => {
    e.preventDefault();
    submitDrawer();
  };

  $('#drawerDelete').onclick = () => {
    if (asset) removeAsset(scope, asset.id);
  };

  updatePreview(scope, asset);
  if (asset && codeInput) lookupAndShow(scope, asset.code);
}

async function searchSuggest(scope, q) {
  const box = $('#suggest');
  try {
    const { results } = await api(`/api/search?scope=${scope}&q=${encodeURIComponent(q)}`);
    if (!results.length) {
      box.innerHTML = '<div style="cursor:default;color:var(--paper-4)">没有匹配结果</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = results
      .map(
        (r) => `<div data-code="${esc(r.code)}" data-name="${esc(r.name)}" data-symbol="${esc(r.symbol || '')}">
          <b style="font-weight:500">${esc(r.name)}</b><span>${esc(r.code)}${r.symbol ? ` · ${esc(r.symbol)}` : ''}</span>
        </div>`,
      )
      .join('');
    box.hidden = false;
    $$('div[data-code]', box).forEach((d) => {
      d.onclick = () => {
        $('#f_code').value = d.dataset.code;
        const nameEl = $('#drawerForm').elements.name;
        if (nameEl && !nameEl.value) nameEl.value = d.dataset.name;
        const symEl = $('#drawerForm').elements.symbol;
        if (symEl && !symEl.value && d.dataset.symbol) symEl.value = d.dataset.symbol;
        box.hidden = true;
        lookupAndShow(drawer.scope, d.dataset.code);
      };
    });
  } catch (err) {
    box.innerHTML = `<div style="cursor:default;color:var(--seal-2)">${esc(err.message)}</div>`;
    box.hidden = false;
  }
}

async function lookupAndShow(scope, code) {
  const pv = $('#preview');
  if (!pv || !code) return;
  pv.innerHTML = '<div class="pr"><span>参考行情</span><b>获取中…</b></div>';
  try {
    const { asset } = await api(`/api/lookup?scope=${scope}&code=${encodeURIComponent(code)}`);
    drawer.preview = asset;
    if (asset.name && !$('#drawerForm').elements.name?.value) $('#drawerForm').elements.name.value = asset.name;
    if (scope === 'crypto' && asset.symbol && !$('#drawerForm').elements.symbol?.value) {
      $('#drawerForm').elements.symbol.value = asset.symbol;
    }
    updatePreview(scope);
  } catch (err) {
    pv.innerHTML = `<div class="pr"><span>参考行情</span><b style="color:var(--seal-2)">${esc(err.message)}</b></div>`;
  }
}

function updatePreview(scope, asset) {
  const pv = $('#preview');
  if (!pv) return;
  const v = collect($('#drawerForm'));
  const qty = Number(v.quantity) || 0;
  const price = Number(v.costPrice) || 0;
  const live = drawer.preview?.price;
  const rows = [];

  if (asset) {
    rows.push(['当前行情', live != null ? `${fmt.price(live)}（${asset.priceDate || asset.lastUpdate || '—'}）` : '—']);
  } else if (live != null) {
    rows.push(['最新行情', fmt.price(live)]);
  } else {
    rows.push(['参考行情', '填写代码后自动获取']);
  }

  if (scope === 'crypto') {
    const cur = v.currency === 'CNY' ? '¥' : '$';
    const rate = v.currency === 'CNY' ? 1 : Number(S.computed.usdCny) || 7.1;
    rows.push(['本次投入成本', fmt.money(qty * price * rate)]);
    if (live != null) rows.push(['按最新价的参考市值', fmt.money(qty * (v.currency === 'CNY' ? drawer.preview.priceCny ?? live : live) * rate)]);
    rows.push(['计价货币', cur]);
  } else if (scope === 'fund') {
    const total = v.costAmount !== '' && v.costAmount !== undefined && !assetCostDirty(v, asset) ? Number(v.costAmount) || 0 : qty * price;
    rows.push(['持仓总成本', fmt.money(total)]);
    if (live != null) rows.push(['按最新净值的市值', fmt.money(qty * live)]);
    if (v.dcaEnabled === true || v.dcaEnabled === 'on') rows.push(['日定投', `${fmt.money(Number(v.dcaAmount) || 0)} / 交易日`]);
  } else {
    rows.push(['持仓成本', fmt.money(qty * price)]);
    if (live != null) rows.push(['按最新价的市值', fmt.money(qty * live)]);
  }

  pv.innerHTML = rows.map(([k, val]) => `<div class="pr"><span>${esc(k)}</span><b>${esc(val)}</b></div>`).join('');
}

function assetCostDirty(v, asset) {
  if (!asset) return false;
  return Number(v.costAmount) !== Number(asset.costAmount);
}

async function submitDrawer() {
  const scope = drawer.scope;
  const v = collect($('#drawerForm'));
  const btn = $('#drawerSubmit');
  btn.disabled = true;
  try {
    if (!v.code?.trim()) throw new Error('请填写代码');
    if (!v.name?.trim()) v.name = v.code.trim();

    if (drawer.id) {
      // 只提交真正被改过的字段（服务端对 costAmount / costPrice 有优先级规则）
      const init = drawer.initial;
      const data = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === 'code') continue;
        if (String(val) !== String(init[k])) data[k] = val;
      }
      if (scope === 'fund') {
        data.dca = {
          enabled: Boolean(v.dcaEnabled),
          amount: Number(v.dcaAmount) || 0,
          startDate: v.dcaStartDate,
        };
      }
      if (data.quantity !== undefined) data.quantity = Number(data.quantity);
      if (data.costPrice !== undefined) data.costPrice = Number(data.costPrice);
      if (data.costAmount !== undefined) data.costAmount = Number(data.costAmount);
      const res = await api('/api/assets', { method: 'PATCH', body: { scope, id: drawer.id, data } });
      applyState(res.state);
      toast(res.message, [`${scope === 'fund' ? '份额' : '数量'} ${fmt.qty(res.asset.quantity)} · 总成本 ${fmt.money(res.asset.costAmount)}`]);
    } else {
      const data = { code: v.code.trim(), name: v.name.trim(), quantity: Number(v.quantity) || 0, costPrice: Number(v.costPrice) || 0, note: v.note };
      if (scope === 'fund') {
        data.dca = { enabled: Boolean(v.dcaEnabled), amount: Number(v.dcaAmount) || 0, startDate: v.dcaStartDate };
      }
      if (scope === 'crypto') {
        data.currency = v.currency;
        data.symbol = v.symbol;
      }
      const res = await api('/api/assets', { method: 'POST', body: { scope, data } });
      applyState(res.state);
      toast(res.message, scope === 'fund' && v.dcaEnabled ? [`已开启日定投 ${fmt.money(Number(v.dcaAmount) || 0)}，点击「更新净值 & 定投」开始按交易日补算`] : []);
    }
    closeDrawer();
  } catch (err) {
    toast('操作失败', [err.message], 'err');
  } finally {
    btn.disabled = false;
  }
}

async function removeAsset(scope, id) {
  const asset = (scope === 'stock' ? S.stocks : scope === 'fund' ? S.funds : S.crypto).find((x) => x.id === id);
  if (!asset) return;
  if (!window.confirm(`确认删除「${asset.name}」？该操作会同时删除它的历史记录，且不可撤销。`)) return;
  try {
    const res = await api(`/api/assets?scope=${scope}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    applyState(res.state);
    closeDrawer();
    toast(res.message, [], 'ok');
  } catch (err) {
    toast('删除失败', [err.message], 'err');
  }
}

/* ============================================================ 更新行情 */

async function runUpdate(scope) {
  const btn = $('#btnUpdate');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('busy');
  const t0 = Date.now();
  try {
    const res = await api('/api/update', { method: 'POST', body: { scope } });
    const reports = res.reports || [];

    // 把发生变化的行标记出来，渲染后闪烁
    for (const rep of reports) {
      for (const it of rep.items || []) {
        if (it.error) continue;
        const delta = Number(it.change) || 0;
        if (delta !== 0) flashQueue.set(it.id, { dir: delta, at: Date.now() });
      }
    }
    S = res.state;
    render();

    const allErrors = reports.flatMap((r) => r.errors || []);
    for (const rep of reports) {
      const lines = [];
      const label = SCOPE_META[rep.scope]?.title || rep.scope;
      if (rep.summary?.message) lines.push(rep.summary.message);
      else {
        lines.push(`成功 ${rep.summary.updated} 项${rep.summary.failed ? ` · 失败 ${rep.summary.failed} 项` : ''}`);
        if (rep.summary.totalChange !== undefined) {
          lines.push(`价格贡献 ${fmt.signed(rep.summary.totalChange)}`);
        }
        if (rep.summary.dca) {
          const d = rep.summary.dca;
          lines.push(d.applied > 0 ? `定投补算 ${d.applied} 个交易日 · 投入 ${fmt.money(d.amount)} · 新增 ${fmt.qty(d.units)} 份` : '定投：无待补算交易日');
        }
      }
      const dcaItems = (rep.items || []).filter((it) => it.dca?.applied > 0);
      for (const it of dcaItems.slice(0, 3)) {
        const last = it.dca.dates.slice(-3).map((d) => `${d.date} ¥${d.amount}÷${d.nav}=+${d.units}份`);
        lines.push(`${it.name}: ${last.join(' / ')}`);
      }
      toast(`${label}更新完成 · ${((Date.now() - t0) / 1000).toFixed(1)}s`, lines, allErrors.length ? 'warn' : 'ok', 7600);
    }
    if (allErrors.length) {
      toast('部分标的更新失败', allErrors.slice(0, 5).map((e) => `${e.name}: ${e.message}`), 'err', 9000);
    }
  } catch (err) {
    toast('更新失败', [err.message], 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

/* ============================================================ 启动 */

async function boot() {
  initContrast();
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => switchTab(n.dataset.tab)));
  $('#btnUpdate').addEventListener('click', () => runUpdate(tab === 'overview' ? 'all' : tab));
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerCancel').addEventListener('click', closeDrawer);
  $('#backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.open) closeDrawer();
  });
  // 地址栏 hash 变化也要切板块：否则 #stock 这类深链只有「刷新页面」时才生效，
  // 手动改地址栏、或从外部点链接进来，都会停在原来的板块
  window.addEventListener('hashchange', () => {
    const next = location.hash.slice(1);
    if (SCOPE_META[next] && next !== tab) switchTab(next);
  });
  // 点击抽屉外部任意位置收起搜索下拉（只注册一次）
  document.addEventListener('click', (e) => {
    if (!drawer.open) return;
    if (!e.target.closest('.autocomplete')) $('#suggest').hidden = true;
  });

  try {
    const { state } = await api('/api/state');
    S = state;
    const hash = location.hash.slice(1);
    if (SCOPE_META[hash]) tab = hash;
    $$('.view').forEach((v) => (v.hidden = v.id !== `view-${tab}`));
    $$('.nav-item').forEach((n) => n.classList.toggle('on', n.dataset.tab === tab));
    render();
  } catch (err) {
    $('#view-overview').innerHTML = `<div class="empty"><div class="seal-ghost">!</div><p>无法连接本地服务</p><p class="small">${esc(err.message)}</p></div>`;
  }
}

boot();
