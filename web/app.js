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
  /**
   * 基金成本 / 持仓均价：最多 6 位小数，去掉多余尾零。
   * 服务端 decorate 里就是 round(avgCost, 6)，通用 price() 对 ≥1 的数只给 3 位，会看不出精度。
   */
  cost(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
  },
  /**
   * 加密货币数量：最多 15 位小数，去掉多余尾零。
   * 币的数量常常很小（0.008090321234567 BTC），通用的 qty() 只给 4 位会把精度截掉；
   * 也不能全局放开位数 —— 否则股票 100 股会显示成 100.0000000000。
   */
  cryptoQty(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 15 });
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
  /**
   * 当日盈亏单元格：数值在上、百分比在下。
   * 数值 = 当日涨跌 × 持仓（即「这一项今天让我赚/亏了多少钱」），
   * 不是每单位的价格变动 —— 价格变动看「现价」列即可。
   */
  dayMove(value, pct, { symbol = '¥', dp = 2, dpPct = 2, title = '' } = {}) {
    const hasPct = pct !== null && pct !== undefined && !Number.isNaN(Number(pct));
    const pctLine = hasPct ? `<br><span class="sub">${fmt.pct(pct, dpPct)}</span>` : '';
    const tip = title ? ` title="${esc(title)}"` : '';
    // 没有当日行情（停牌 / 净值未公布）：百分比那行也留空，避免表格高度跳动
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return `<span class="dim"${tip}>—</span>${pctLine}`;
    }
    // 持仓口径的金额一定是「钱」，两端对齐到分即可：既不抹零也不拖尾
    const v = Number(value);
    const sign = v > 0 ? '+' : v < 0 ? '-' : '';
    const text = Math.abs(v).toLocaleString('zh-CN', nf(dp));
    return `<b${tip}>${sign}${symbol}${text}</b>${pctLine}`;
  },
  signed(n, dp = 2) {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    return `${v > 0 ? '+' : ''}${v.toLocaleString('zh-CN', nf(dp))}`;
  },
  /** 固定小数位的带符号数（用于 tooltip 里说明口径，精度要够小值也看得见） */
  exactSigned(n, dp = 4) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    return fmt.signed(n, dp);
  },
  /** 带符号与货币符号：+$64.98 / -¥1,234.00 */
  signedMoney(n, symbol, dp = 2) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    const sign = v > 0 ? '+' : v < 0 ? '-' : '';
    return `${sign}${symbol}${Math.abs(v).toLocaleString('zh-CN', nf(dp))}`;
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

/* ------------------------------------------------------------ 排序状态 */

/** manual = 自定义（可拖动排序），其余按字段排序 */
const SORT_FIELDS = {
  manual: { label: '自定义', key: null, hint: '按你拖动的顺序排列' },
  marketValue: { label: '市值', key: 'marketValue', hint: '按市值排序（点击切换升降序）' },
  pnl: { label: '盈亏额', key: 'pnl', hint: '按盈亏金额排序（点击切换升降序）' },
  pnlPct: { label: '盈亏率', key: 'pnlPct', hint: '按收益率排序（点击切换升降序）' },
};
const SORT_STORE_KEY = 'stockview.sort';
const sortState = {
  stock: { by: 'manual', desc: true },
  fund: { by: 'manual', desc: true },
  crypto: { by: 'manual', desc: true },
};

function loadSortState() {
  try {
    const raw = localStorage.getItem(SORT_STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const scope of Object.keys(sortState)) {
      if (saved?.[scope] && SORT_FIELDS[saved[scope].by]) {
        sortState[scope] = { by: saved[scope].by, desc: saved[scope].desc !== false };
      }
    }
  } catch {
    /* 忽略损坏的本地设置 */
  }
}

function saveSortState() {
  try {
    localStorage.setItem(SORT_STORE_KEY, JSON.stringify(sortState));
  } catch {
    /* 隐私模式忽略 */
  }
}

/* ------------------------------------------------------------ 屏蔽状态 */

/**
 * 每个账页是否「把屏蔽项也显示在表格里」。
 *
 * 注意这是纯**显示**开关：合计口径与它无关 —— 屏蔽项永远不计入合计。
 *   - 关闭（默认）：屏蔽项从表格里收起来；
 *   - 打开：屏蔽项以半透明行显示并标注「已屏蔽」，方便随时恢复。
 */
const HIDDEN_STORE_KEY = 'stockview.showHidden';
const showHidden = { stock: false, fund: false, crypto: false };

function loadShowHidden() {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_STORE_KEY) || '{}');
    for (const scope of Object.keys(showHidden)) showHidden[scope] = Boolean(saved?.[scope]);
  } catch {
    /* 忽略损坏的本地设置 */
  }
}

function saveShowHidden() {
  try {
    localStorage.setItem(HIDDEN_STORE_KEY, JSON.stringify(showHidden));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 当前表格里该板块「计入合计」的行 */
function visibleRows(scope) {
  const all = rowsOfScope(scope);
  return showHidden[scope] ? all : all.filter((r) => !r.hidden);
}

/**
 * 合计永远只算「未屏蔽」的部分 —— 屏蔽的语义就是「这项先不算」。
 *
 * 这里刻意不提供「含屏蔽项」的口径：屏蔽时行情字段会被清空，
 * 把这样一行算进合计只会得到「市值 0、亏损 100%」的假数字。
 */
function totalsFor() {
  return S.computed.totals;
}

function byScopeFor(scope) {
  return S.computed.byScope[scope];
}

function sortRows(scope, rows) {
  const s = sortState[scope];
  const field = s && SORT_FIELDS[s.by]?.key;
  if (!field) return rows;
  return [...rows].sort((a, b) => {
    const va = Number(a[field]) || 0;
    const vb = Number(b[field]) || 0;
    return s.desc ? vb - va : va - vb;
  });
}

function rowsOfScope(scope) {
  return scope === 'stock' ? S.stocks : scope === 'fund' ? S.funds : S.crypto;
}

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
  const actions = $('#busyActions');
  if (actions) actions.hidden = true;
  stopBusyPolling();
}

function stopBusyPolling() {
  if (busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}

/** 显示遮罩并轮询服务端真实进度（而不是干转一个圈） */
async function startBusyPolling(title, firstLabel, { cancelable = false } = {}) {
  stopBusyPolling();
  showBusy(title, firstLabel);
  const actions = $('#busyActions');
  if (actions) actions.hidden = !cancelable;
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

/**
 * 迷你走势图。
 *
 * ⚠️ 两个坑都踩过：
 *  1. 早先写的是 `span = max - min || 1`。当窗口内**所有值完全相等**
 *     （停牌、当天净值还没出、刚加入还没走势）时，这个兜底会让
 *     `(v - min) / span` 恒为 0，线被钉在盒子最底部（y = h-2），
 *     视觉上像「掉到单元格下面去了」。现在这种情况直接画在中线。
 *  2. 描边有宽度、路径又画满了 viewBox 的 x 方向，端点会各溢出半个线宽。
 *     所以两端各留 1px 内缩（配合 CSS 去掉 overflow: visible），
 *     走势图就老老实实待在自己的盒子里，不会压到相邻列。
 */
function sparkline(points, { w = 90, h = 26 } = {}) {
  const vals = (points || []).map((p) => Number(p.close ?? p.nav ?? p.price)).filter(Number.isFinite);
  if (vals.length < 3) return '<span class="dim mono" style="font-size:11px">数据不足</span>';

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;
  const padX = 1; // 让描边端点留在盒子内
  const mid = h / 2;
  const innerW = w - padX * 2;
  const step = innerW / (vals.length - 1);

  const d = vals
    .map((v, i) => {
      const x = padX + i * step;
      // 全等值 → 居中一条水平线；否则按区间铺满（上下各留 2px 给描边）
      const y = span === 0 ? mid : h - ((v - min) / span) * (h - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

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
  const t = totalsFor();
  const el = $('#view-overview');
  const hiddenTotal = c.hiddenCount?.total || 0;

  const alloc = c.allocation.filter((a) => a.value > 0);
  const ribbon = alloc.length
    ? alloc
        .slice(0, 14)
        .map((a, i) => {
          const color = PALETTE[i % PALETTE.length];
          const w = Math.max(a.weight, 1.2);
          // 同代码多条时用「代码 · 账户」区分，否则两段标签一模一样
          const label = a.note ? `${a.code}·${a.note}` : a.code || a.name;
          return `<div class="ribbon-seg" style="flex:${w} 1 0;background:${color}" title="${esc(a.name)}${a.note ? `（${esc(a.note)}）` : ''} ${fmt.money(a.value)} · ${a.weight}%">
            ${w > 7 ? `<em>${esc(label).slice(0, 12)} ${a.weight.toFixed(1)}%</em>` : ''}
          </div>`;
        })
        .join('')
    : '<div class="ribbon-seg" style="flex:1;background:var(--ink-4)"><em>暂无持仓</em></div>';

  const legend = alloc
    .slice(0, 10)
    .map((a, i) => {
      const color = PALETTE[i % PALETTE.length];
      return `<div class="legend-item"><i class="legend-dot" style="background:${color}"></i>${esc(a.name)}${a.note ? ` <em class="acct">${esc(a.note)}</em>` : ''} <b>${fmt.money(a.value)}</b> · ${a.weight}%</div>`;
    })
    .join('');

  const card = (key) => {
    const meta = SCOPE_META[key];
    const b = c.byScope[key];
    const list = key === 'stock' ? S.stocks : key === 'fund' ? S.funds : S.crypto;
    const pending = key === 'fund' ? c.dca.pendingDays : 0;
    // 盈亏一律带货币符号：股票/基金用 ¥；加密货币把人民币金额紧跟「盈亏」，美元金额排在其后
    const pnlMain =
      key === 'crypto'
        ? `${fmt.signedMoney(b.pnl, '¥')} ${fmt.signedMoney(b.pnlNative, '$')}`
        : fmt.signedMoney(b.pnl, '¥');
    const pnlNote =
      key === 'fund'
        ? pending > 0
          ? `<b class="warn" style="color:var(--gold)">待定投 ${pending} 日</b>`
          : '定投已同步'
        : `成本 <b>${fmt.num(b.cost, 0)}</b>`;
    return `<div class="card" data-goto="${key}">
      <div class="card-head"><b>${meta.title}</b><em>${list.length - (c.hiddenCount?.[key] || 0)} 项 · ${t.marketValue > 0 ? ((b.marketValue / t.marketValue) * 100).toFixed(1) : '0.0'}%</em></div>
      <div class="card-value">${fmt.money(b.marketValue)}</div>
      <div class="card-foot">
        <span>盈亏 <b class="${fmt.cls(b.pnl)}">${pnlMain}</b> · <b class="${fmt.cls(b.pnl)}">${fmt.pct(b.pnlPct)}</b></span>
        <span>${pnlNote}</span>
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
          <div class="stat"><span>今日</span><b class="${fmt.cls(t.dayValueCny)}">${fmt.signedMoney(t.dayValueCny, '¥')}</b><small class="${fmt.cls(t.dayPct)}">${fmt.pct(t.dayPct)}</small></div>
          <div class="stat"><span>累计盈亏</span><b class="${fmt.cls(t.pnl)}">${fmt.signed(t.pnl)}</b><small class="${fmt.cls(t.pnl)}">${fmt.pct(t.pnlPct)}</small></div>
          <div class="stat"><span>持仓标的</span><b>${t.count}</b></div>
          ${hiddenTotal ? `<div class="stat"><span>已屏蔽</span><b class="dim">${hiddenTotal}</b><small class="dim">不计入上方合计</small></div>` : ''}
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
    { k: '', cls: 'drag-col' },
    { k: '标的', cls: 'l' },
    { k: '持股' }, { k: '成本价' }, { k: '现价' }, { k: '今日盈亏' },
    { k: '市值' }, { k: '浮动盈亏' }, { k: '收益率' },
    // 「操作」列的表头不能加 .l（左对齐）：行里的按钮是贴右边缘的，
    // 表头左对齐会与按钮差近 100px。让表头跟着按钮一起右对齐。
    { k: '走势' }, { k: '操作' },
  ],
  fund: [
    { k: '', cls: 'drag-col' },
    { k: '标的', cls: 'l' },
    { k: '持有份额' }, { k: '持仓均价' }, { k: '单位净值' }, { k: '当日盈亏' },
    { k: '市值' }, { k: '浮动盈亏' }, { k: '收益率' }, { k: '日定投' }, { k: '已定投' },
    { k: '走势' }, { k: '操作' },
  ],
  crypto: [
    { k: '', cls: 'drag-col' },
    { k: '标的', cls: 'l' },
    { k: '数量' }, { k: '成本价' }, { k: '现价' }, { k: '24h 盈亏' },
    { k: '市值 (¥)' }, { k: '浮动盈亏' }, { k: '收益率' },
    { k: '操作' },
  ],
};

/** 拖动把手（排序状态下变暗且不可拖） */
const GRIP = '<td class="drag-col"><span class="grip" title="按住拖动可调整顺序">⠿</span></td>';

/** 面板头部的排序切换按钮 */
function sortBar(scope) {
  const s = sortState[scope];
  const btns = Object.entries(SORT_FIELDS)
    .map(([key, f]) => {
      const on = s.by === key;
      const arrow = on && key !== 'manual' ? (s.desc ? ' ↓' : ' ↑') : '';
      return `<button class="sort-btn${on ? ' on' : ''}" data-sort="${key}" title="${esc(f.hint)}">${esc(f.label)}${arrow}</button>`;
    })
    .join('');
  return `<div class="sort-bar"><span class="sort-label">排序</span>${btns}</div>`;
}

function panelStats(key) {
  const b = byScopeFor(key);
  const lu = S.meta.lastUpdate[key];
  const hiddenCount = S.computed.hiddenCount?.[key] || 0;
  const items = [
    ['市值', fmt.money(b.marketValue)],
    ['成本', fmt.money(b.cost)],
    ['浮动盈亏', `<span class="${fmt.cls(b.pnl)}">${fmt.signedMoney(b.pnl, '¥')}</span> / <span class="${fmt.cls(b.pnlPct)}">${fmt.pct(b.pnlPct)}</span>`],
  ];
  if (key === 'fund') {
    const scopeDca = S.computed.dca;
    items.push(['日定投合计', fmt.money(scopeDca.dailyAmount)]);
    items.push(['待执行交易日', scopeDca.pendingDays > 0 ? `<span style="color:var(--gold)">${scopeDca.pendingDays} 天</span>` : '已同步']);
    items.push(['累计定投', `${scopeDca.totalCount} 笔 · ${fmt.money(scopeDca.totalInvested)}`]);
  } else if (key === 'crypto') {
    // 加密货币以原币（美元）表达盈亏，人民币是按实时汇率折算的参考值
    const rateStr = Number(S.computed.usdCny).toFixed(4);
    const idx = items.findIndex(([k]) => k === '浮动盈亏');
    items[idx] = [
      '浮动盈亏 (USD)',
      `<span class="${fmt.cls(b.pnlNative)}">${fmt.signedMoney(b.pnlNative, '$')}</span> / <span class="${fmt.cls(b.pnlPct)}">${fmt.pct(b.pnlPct)}</span>` +
        `<br><span class="dim" style="font-weight:400;font-size:11px">${fmt.signedMoney(b.pnl, '¥')}（汇率 ${rateStr}）</span>`,
    ];
    items.push(['成本 (USD)', `$${fmt.num(b.costNative, 2)}`]);
    items.push(['USD/CNY', rateStr]);
  } else {
    // 「自上次更新」已从明细表移除，这里改成与「今日盈亏」列同一个口径的合计，
    // 口径与总览的「今日」一致（缺失当日行情的标的按 0 计）
    items.push(['今日盈亏', `<span class="${fmt.cls(b.dayValueCny)}">${fmt.signedMoney(b.dayValueCny, '¥')}</span>`]);
  }
  if (hiddenCount) {
    items.push([
      '屏蔽项',
      `<span class="dim">${hiddenCount} 项 · 未计入</span>`,
    ]);
  }
  items.push(['上次更新', fmt.date(lu)]);
  return items.map(([k, v]) => `<div class="pstat"><span>${k}</span><b>${v}</b></div>`).join('');
}

/**
 * 「屏蔽条」：账页顶部说明当前合计口径：
 *   - 有屏蔽项时给出「屏蔽后的整体内容」与一键显示 / 收起；
 *   - 没有屏蔽项时给出一句口径说明与合计市值，保持视觉一致。
 */
function hiddenBar(key) {
  const c = S.computed;
  const count = c.hiddenCount?.[key] || 0;
  const showing = showHidden[key];
  const scopeTotals = c.byScope[key];
  // 被屏蔽项自己的合计（行情冻在屏蔽那一刻），用于说明「排除掉了多少」
  const raw = c.byScopeRaw?.[key] || scopeTotals;

  if (!count) {
    return `<div class="hidden-bar quiet">
      <div class="hb-main">
        <b>整体内容</b>
        <span>未屏蔽任何${SCOPE_META[key].title} · 市值 <b>${fmt.money(scopeTotals.marketValue)}</b> · 盈亏 <b class="${fmt.cls(scopeTotals.pnl)}">${fmt.signedMoney(scopeTotals.pnl, '¥')}</b>（${fmt.pct(scopeTotals.pnlPct)}）</span>
      </div>
    </div>`;
  }

  const excludedValue = Math.max(0, raw.marketValue - scopeTotals.marketValue);
  return `<div class="hidden-bar${showing ? ' showing' : ''}">
    <div class="hb-main">
      <b>${count} 项已屏蔽${showing ? '（下方列出，仍不计入合计）' : ''}</b>
      <span>整体内容（不含屏蔽项）：市值 <b>${fmt.money(scopeTotals.marketValue)}</b> · 成本 <b>${fmt.money(scopeTotals.cost)}</b> · 盈亏 <b class="${fmt.cls(scopeTotals.pnl)}">${fmt.signedMoney(scopeTotals.pnl, '¥')}</b>（${fmt.pct(scopeTotals.pnlPct)}）
      · 已排除 <b>${fmt.money(excludedValue)}</b>（成本 ${fmt.money(raw.cost - scopeTotals.cost)}）
      <br><span class="dim">屏蔽不会删数据：持仓、成本、行情都原样留着，只是暂不计入合计；点「取消屏蔽」立刻还原。</span></span>
    </div>
    <button class="btn-ghost hb-btn" data-togglehidden="${key}">${showing ? '收起屏蔽项' : '显示屏蔽项'}</button>
  </div>`;
}

/** 标的一栏：名称 + 账户备注徽标 + 代码。同代码多条时，账户是唯一能区分的信息 */
function whoCell(r, code) {
  return `<div class="who">
      <div class="who-top"><b>${esc(r.name)}</b>${r.note ? `<em class="acct" title="账户 / 备注">${esc(r.note)}</em>` : ''}${r.hidden ? '<em class="acct hidden-tag" title="已屏蔽，不计入任何合计">已屏蔽</em>' : ''}</div>
      <span>${code}</span>
    </div>`;
}

/**
 * 屏蔽行**照常显示真实数字**，只是整行压暗并标注「已屏蔽」。
 *
 * 数据并没有被丢掉：屏蔽期间行情只是"冻住"（更新行情会跳过它），
 * 所以这里显示的是屏蔽那一刻的价格 / 成本 / 盈亏 —— 你能一眼看出这一项现在值多少，
 * 只是它没算进合计。取消屏蔽后数字原样回到合计里，不需要重新拉行情。
 *
 * 早期版本把这些单元格换成「—」，看起来像数据被删了；用户的反馈是
 * 「屏蔽了之后把成本价搞没了」。
 */
const dimIfHidden = (r) => (r.hidden ? 'dim' : '');

/** 每行末尾的操作区：屏蔽 / 取消屏蔽 + 修改 + 删除 */
function rowActions(r) {
  const fix = r.costMismatch ? `<button class="linky" data-fixcost="${esc(r.id)}">修正成本</button>` : '';
  const hide = r.hidden
    ? `<button class="linky" data-unhide="${esc(r.id)}">取消屏蔽</button>`
    : `<button class="linky" data-hide="${esc(r.id)}">屏蔽</button>`;
  return `<div class="row-actions">${fix}${hide}<button class="linky" data-edit="${esc(r.id)}">修改</button><button class="linky danger" data-del="${esc(r.id)}">删除</button></div>`;
}

function rowStock(r) {
  const dp = 4;
  const flag = r.costMismatch
    ? `<br><span class="badge wait" title="总成本与「数量 × 成本价」不一致，应修正为 ${fmt.money(r.expectedCost)}">成本异常</span>`
    : '';
  return `<tr data-id="${esc(r.id)}">
    ${GRIP}
    <td class="l">${whoCell(r, esc(r.code))}</td>
    <td>${fmt.qty(r.quantity)}</td>
    <td>${fmt.price(r.avgCost, dp)}${flag}</td>
    <td class="${dimIfHidden(r)}"><b>${fmt.price(r.price, dp)}</b></td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.dayValueCny)}" title="今日盈亏 = (现价 − 昨收) × 持股">${fmt.dayMove(r.dayValueCny, r.dayChangePct, { title: `每股价 ${fmt.exactSigned(r.dayChangeValue, 4)} 元 × ${fmt.qty(r.quantity)} 股` })}</td>
    <td class="${dimIfHidden(r)}">${fmt.money(r.marketValue)}</td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.pnl)}">${fmt.signedMoney(r.pnl, '¥')}</td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.pnlPct)}">${fmt.pct(r.pnlPct)}</td>
    <td>${sparkline(r.history)}</td>
    <td class="l">${rowActions(r)}</td>
  </tr>`;
}

function rowFund(r) {
  const dcaOn = r.dca?.enabled && Number(r.dca.amount) > 0;
  const dcaCell = dcaOn
    ? `<span class="badge on">¥${fmt.num(r.dca.amount, 0)}/日</span>`
    : '<span class="badge">未开启</span>';
  const pending = r.pendingDays > 0 ? `<span class="badge wait">待 ${r.pendingDays} 日</span>` : '';
  // 屏蔽期间不补算定投，所以这里标注「定投暂停」而不是假装已同步
  const dcaNow = r.hidden ? `${dcaCell}<br><span class="badge">定投暂停</span>` : `${dcaCell}<br>${pending}`;
  return `<tr data-id="${esc(r.id)}">
    ${GRIP}
    <td class="l">${whoCell(r, `${esc(r.code)}${dcaOn && r.lastDcaDate ? ` · 上次定投 ${esc(r.lastDcaDate)}` : ''}`)}</td>
    <td>${fmt.qty(r.quantity)}</td>
    <td>${fmt.cost(r.avgCost)}</td>
    <td class="${dimIfHidden(r)}"><b>${fmt.price(r.nav)}</b><br><span class="sub dim">${esc(fmt.date(r.navDate))}</span></td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.dayValueCny)}" title="当日盈亏 = 每份净值涨跌 × 持有份额">${fmt.dayMove(r.dayValueCny, r.dayChangePct, { title: `每份净值涨跌 ${fmt.exactSigned(r.dayChangeValue, 4)} 元 × ${fmt.qty(r.quantity)} 份` })}</td>
    <td class="${dimIfHidden(r)}">${fmt.money(r.marketValue)}</td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.pnl)}">${fmt.signedMoney(r.pnl, '¥')}</td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.pnlPct)}">${fmt.pct(r.pnlPct)}</td>
    <td>${dcaNow}</td>
    <td>${r.dcaCount > 0 ? `${r.dcaCount} 笔<br><span class="sub dim">${fmt.money(r.dcaInvested)} · ${fmt.qty(r.dcaUnits)} 份</span>` : '<span class="dim">—</span>'}</td>
    <td>${sparkline(r.history)}</td>
    <td class="l">${rowActions(r)}</td>
  </tr>`;
}

function rowCrypto(r) {
  const cur = r.currency === 'CNY' ? '¥' : '$';
  const src = { binance: 'Binance', gate: 'Gate.io', okx: 'OKX', coingecko: 'CoinGecko' }[r.priceSource] || r.priceSource;
  return `<tr data-id="${esc(r.id)}">
    ${GRIP}
    <td class="l">${whoCell(r, `${esc(r.symbol)} · ${esc(r.coinId)}${src ? ` · <i class="flag">${esc(src)}</i>` : ''}`)}</td>
    <td>${fmt.cryptoQty(r.quantity)}</td>
    <td>${cur}${fmt.price(r.costPrice, 2)}</td>
    <td class="${dimIfHidden(r)}"><b>${cur}${fmt.price(r.nativePrice, 2)}</b>${r.currency === 'USD' && r.priceCny ? `<br><span class="sub dim">¥${fmt.price(r.priceCny, 2)}</span>` : ''}</td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.dayValueCny)}" title="24h 盈亏（换算成人民币）">${fmt.dayMove(r.dayValueCny, r.dayChangePct, { title: `每枚 ${cur}${fmt.exactSigned(r.dayChangeValue, 6)} × ${fmt.cryptoQty(r.quantity)} 枚，按汇率折人民币` })}</td>
    <td class="${dimIfHidden(r)}">${fmt.money(r.marketValue)}</td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.pnlNative)}"><b>${fmt.signedMoney(r.pnlNative, cur)}</b><br><span class="sub dim">${fmt.signedMoney(r.pnl, '¥')}</span></td>
    <td class="${r.hidden ? 'dim' : fmt.cls(r.pnlPct)}">${fmt.pct(r.pnlPct)}</td>
    <td class="l">${rowActions(r)}</td>
  </tr>`;
}

const ROW_FN = { stock: rowStock, fund: rowFund, crypto: rowCrypto };

function renderTable(key) {
  const all = rowsOfScope(key);
  const hiddenRows = all.filter((r) => r.hidden);
  const rows = sortRows(key, visibleRows(key));
  const manual = sortState[key].by === 'manual';
  const prefix =
    key === 'stock'
      ? '每行记录一只股票的持股与成本；「今日盈亏」＝ (现价 − 昨收) × 持股。同一代码可以有多条，用「账户 / 备注」区分。'
      : key === 'fund'
        ? '日定投在每次「更新净值」时，按 (上次定投日, 最新净值日] 之间每一个交易日的净值折算份额。'
        : '加密货币价格依次尝试 Binance → Gate.io → OKX → CoinGecko，成功的来源会标在标的下面；成本按「计价货币」计入。';
  const cols = COLUMNS[key].map((c) => `<th class="${c.cls || ''}">${c.k}</th>`).join('');

  const body = rows.length
    ? rows
        .map((r, i) =>
          ROW_FN[key](r)
            .replace('<tr ', `<tr class="${r.hidden ? 'row-hidden' : ''}" style="animation-delay:${Math.min(i * 28, 420)}ms" `),
        )
        .join('')
    : '';

  const hint = hiddenRows.length && !showHidden[key]
    ? `另有 <b>${hiddenRows.length}</b> 项已屏蔽（不计入合计，<b>数据都还在</b>），点上方「显示屏蔽项」查看。`
    : manual
      ? '当前为自定义顺序，<b>按住行首的 ⠿ 可拖动调整</b>。'
      : '当前为排序视图，切回「自定义」才能拖动。';

  return `
    <section class="panel">
      ${hiddenBar(key)}
      <div class="panel-head">
        <div class="panel-stats">${panelStats(key)}</div>
        <div class="head-tools">${sortBar(key)}<button class="btn-ghost" data-add="${key}">+ 添加${SCOPE_META[key].title}</button></div>
      </div>
      <p class="dim" style="font-size:12px;margin:-6px 0 16px;max-width:880px">${prefix}${hint}</p>
      <div class="table-wrap${manual ? ' manual' : ' sorted'}">
        <table>
          <thead><tr>${cols}</tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${rows.length ? '' : `<div class="empty"><div class="seal-ghost">空</div><p>${hiddenRows.length ? `全部 ${hiddenRows.length} 项都被屏蔽了` : `还没有${SCOPE_META[key].title}记录`}</p><p class="small">${hiddenRows.length ? '点上方「显示屏蔽项」，或在行末点「取消屏蔽」' : `点击右上角「+ 添加${SCOPE_META[key].title}」开始记账`}</p></div>`}
      </div>
    </section>`;
}

/* ------------------------------------------------------------ 排序与拖动 */

function changeSort(scope, by) {
  if (!SORT_FIELDS[by]) return;
  const s = sortState[scope];
  if (s.by === by) {
    if (by === 'manual') return; // 已经是自定义顺序，无需变化
    s.desc = !s.desc; // 再点同一个字段 → 切换升/降序
  } else {
    s.by = by;
    s.desc = true; // 换字段时默认降序（市值/盈亏都是「大的在前」更常用）
  }
  saveSortState();
  render();
}

/**
 * 行拖动排序。只在「自定义」顺序下启用；拖动结束后把整张表的 id 顺序提交给服务端保存。
 * 事件委托挂在 tbody 上，每次 render 都会重建 tbody，所以不会重复绑定。
 */
function wireDrag(view, scope) {
  const tbody = view.querySelector('tbody');
  if (!tbody || sortState[scope]?.by !== 'manual') return;
  tbody.querySelectorAll('tr').forEach((tr) => tr.setAttribute('draggable', 'true'));

  let dragging = null;
  let moved = false;

  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.draggable) return;
    dragging = tr;
    moved = false;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', tr.dataset.id || '');
    } catch {
      /* 某些浏览器在只读上下文里会拒绝 */
    }
  });

  tbody.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('tr');
    if (!over || over === dragging) return;
    // 直接搬动 DOM，所见即所得；松手后把最终顺序读出来提交
    const rect = over.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    tbody.insertBefore(dragging, after ? over.nextSibling : over);
    moved = true;
  });

  tbody.addEventListener('drop', (e) => {
    if (dragging) e.preventDefault();
  });

  tbody.addEventListener('dragend', async () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    if (!moved) return; // 只是点了一下没移动
    const ids = [...tbody.querySelectorAll('tr')].map((tr) => tr.dataset.id).filter(Boolean);
    const before = rowsOfScope(scope).map((x) => x.id);
    if (ids.join('|') === before.join('|')) return;
    try {
      const res = await api('/api/order', { method: 'POST', body: { scope, ids } });
      applyState(res.state);
      toast('顺序已保存', [`共 ${ids.length} 条`], 'ok', 1600);
    } catch (err) {
      toast('排序保存失败', [err.message], 'err');
      render();
    }
  });
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
            <b>导出数据</b>
            <span>把当前全部持仓与流水下载成一个 JSON 文件，可直接当备份保存。当前共 ${total} 项：股票 ${counts.stock} · 基金 ${counts.fund} · 加密货币 ${counts.crypto}。</span>
          </div>
          <div class="set-action"><button class="btn-ghost" id="setExport">导出 JSON</button></div>
        </div>
        <div class="set-row">
          <div class="set-label">
            <b>导入数据</b>
            <span>选一个之前导出的 JSON 文件，<b>覆盖</b>当前全部数据。导入前会自动把现有数据备份到 <b class="mono">data/backups/</b>，导错了可以回退。</span>
          </div>
          <div class="set-action">
            <button class="btn-ghost" id="setImport">选择文件…</button>
            <input type="file" id="importFile" accept=".json,application/json" hidden />
          </div>
        </div>
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
  $('#setExport')?.addEventListener('click', exportData);
  $('#setImport')?.addEventListener('click', () => $('#importFile')?.click());
  $('#importFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许连续导入同一个文件
    if (file) importData(file);
  });
  $('#setDemo')?.addEventListener('click', rebuildDemo);
  $('#setClear')?.addEventListener('click', clearAll);
}

/** 导出：走服务端的下载接口，浏览器按 Content-Disposition 存成文件 */
function exportData() {
  const a = document.createElement('a');
  a.href = `/api/export?t=${Date.now()}`;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  toast('已开始下载备份', ['内容为全部持仓与流水记录']);
}

/** 导入：先解析看清里面有多少东西，再让用户确认覆盖 */
async function importData(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    toast('导入失败', ['文件不是合法的 JSON：' + err.message], 'err');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    toast('导入失败', ['文件内容不是一个 JSON 对象'], 'err');
    return;
  }
  const n = (k) => (Array.isArray(parsed[k]) ? parsed[k].length : 0);
  if (!n('stocks') && !n('funds') && !n('crypto')) {
    toast('导入失败', ['文件里没有 stocks / funds / crypto 字段，可能不是本程序导出的备份'], 'err');
    return;
  }
  const ok = window.confirm(
    `用「${file.name}」覆盖当前数据？\n\n` +
      `导入内容：股票 ${n('stocks')} · 基金 ${n('funds')} · 加密货币 ${n('crypto')}\n` +
      `当前数据：股票 ${S.stocks.length} · 基金 ${S.funds.length} · 加密货币 ${S.crypto.length}\n\n` +
      `现有数据会先自动备份到 data/backups/。`,
  );
  if (!ok) return;

  showBusy('正在导入数据', '校验并写入…');
  try {
    const res = await api('/api/import', { method: 'POST', body: { data: parsed } });
    hideBusy();
    applyState(res.state);
    toast(res.message, [res.backup ? `原数据已备份为 ${res.backup}` : '（原本没有数据文件，未产生备份）'], 'ok', 9000);
  } catch (err) {
    hideBusy();
    toast('导入失败', [err.message], 'err');
  }
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
    view.querySelectorAll('[data-fixcost]').forEach((b) => b.addEventListener('click', () => fixCost(tab, b.dataset.fixcost)));
    view.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => changeSort(tab, b.dataset.sort)));
    view.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', () => toggleHidden(tab, b.dataset.hide, true)));
    view.querySelectorAll('[data-unhide]').forEach((b) => b.addEventListener('click', () => toggleHidden(tab, b.dataset.unhide, false)));
    view.querySelectorAll('[data-togglehidden]').forEach((b) => b.addEventListener('click', () => toggleHiddenView(b.dataset.togglehidden)));
    wireDrag(view, tab);
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

/**
 * 重新拉一次快照。
 * 合计口径（是否含屏蔽项）由服务端算，所以切换「显示屏蔽项」时必须重新取数，
 * 不能只在前端过滤表格 —— 否则表头合计会与看到的行对不上。
 */
async function refreshState({ quiet = false } = {}) {
  try {
    const { state } = await api('/api/state');
    applyState(state);
  } catch (err) {
    if (!quiet) toast('刷新失败', [err.message], 'err');
  }
}

/** 「显示屏蔽项 / 收起」：只影响显示与合计口径，不改变任何记录 */
function toggleHiddenView(scope) {
  showHidden[scope] = !showHidden[scope];
  saveShowHidden();
  // 立刻按新口径重绘（用服务端已经算好的两套合计），随后再取一次数校准
  render();
  refreshState({ quiet: true });
}

/**
 * 屏蔽 / 取消屏蔽一项资产。
 * 屏蔽后该行仍然留着（可在「显示屏蔽项」里看到并恢复），但行情被冻结、不计入任何合计。
 */
async function toggleHidden(scope, id, hide) {
  const asset = rowsOfScope(scope).find((x) => x.id === id);
  if (!asset) return;
  if (hide) {
    const ok = window.confirm(
      `屏蔽「${asset.name}」？\n\n` +
        `· 它不再计入总市值 / 成本 / 盈亏 / 权重等任何合计；\n` +
        `· 记录、持仓、成本、行情**原样保留**，不会丢任何数据；\n` +
        `· 更新行情时会跳过它（不取价、不补定投），行情就停在现在这一刻；\n` +
        `· 随时点「取消屏蔽」立刻还原，不需要重新拉行情。`,
    );
    if (!ok) return;
  }
  try {
    const res = await api('/api/assets/hidden', { method: 'POST', body: { scope, id, hidden: hide } });
    applyState(res.state);
    toast(
      res.message,
      hide
        ? ['数据原样保留，只是暂不计入合计', '更新行情会跳过它，行情停在当前这一刻']
        : ['持仓、成本、行情原样还原，无需重新更新'],
      hide ? 'warn' : 'ok',
      5600,
    );
  } catch (err) {
    toast(hide ? '屏蔽失败' : '恢复失败', [err.message], 'err');
  }
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
  /** 记录用户手动改过哪些字段（如 name / symbol），用于判断能否自动带出 */
  touched: {},
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
  drawer.touched = {};
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
    // 成本字段必须与表格里的「均价」显示同一个值。
    // 之前抽屉显示 costPrice、表格显示 costAmount÷数量，两者脱节时用户会看到
    // “表格里均价是错的、打开抽屉却已经是想改的那个数”，于是改不动也提交不出去。
    // 加密货币例外：均价是折算后的人民币，输入框要的是原币，单位不同不能混用。
    const costLabel = asset
      ? scope === 'crypto' ? '成本价' : scope === 'fund' ? '持仓均价（由总成本推算）' : '持仓成本价'
      : scope === 'fund' ? '成本价（单位净值）' : '成本价';
    const costValue = asset ? numStr(scope === 'crypto' ? asset.costPrice : asset.avgCost, scope === 'fund' ? 6 : 4) : '';
    const costHint = asset && scope !== 'crypto' ? '与表格里的「均价」是同一个值；改动后会按 数量 × 该值 重算总成本。' : '';
    html += `<div class="field-row">
      ${field(scope === 'fund' ? '持有份额' : '持股数量', 'quantity', { type: 'number', step: 'any', value: asset ? numStr(asset.quantity, 4) : '', placeholder: scope === 'fund' ? '1000' : '100' })}
      ${field(costLabel, 'costPrice', { type: 'number', step: 'any', value: costValue, hint: costHint, placeholder: scope === 'fund' ? '2.5' : '1180.5' })}
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
      </div>
      ${asset ? `<div class="field">
        <label class="switch"><input type="checkbox" name="resetDca" /><span class="track"></span><b>重置定投记录</b></label>
        <span class="hint">勾选并保存后，会清空已定投笔数 / 累计投入 / 上次定投日，下次更新从「起始日期」重新补算。<b>只在你把这一行换成另一只基金时才需要</b>；只是改代码笔误不要勾，否则会重复扣一遍定投。</span>
      </div>` : ''}`;
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
      ${field('持有数量', 'quantity', { type: 'number', step: 'any', value: asset ? numStr(asset.quantity, 15) : '', placeholder: '0.35' })}
      ${field('成本价', 'costPrice', {
        type: 'number',
        step: 'any',
        value: asset ? numStr(asset.costPrice, 2) : '',
        placeholder: '61200',
        hint: `按${asset?.currency === 'CNY' ? '人民币' : '美元'}计价。盈亏按「数量 ×（现价 − 成本价）」计算，人民币金额用实时汇率折算，不锁定入库时的汇率。`,
      })}
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

  html += field('账户 / 备注', 'note', {
    value: asset?.note || '',
    placeholder: '例如：华泰证券 / 币安 / 招行',
    hint: '同一个代码可以添加多条（例如同一只股票放在不同券商），用这里区分；<b>同代码 + 同备注</b>会被视为重复而拒绝。',
  });

  // 屏蔽：记录留着，但不参与任何合计。放在表单最后，因为它影响的是「汇总」而不是「持有」
  html += `<div class="field" style="border-top:1px solid var(--line);padding-top:20px">
    <label>屏蔽这一项</label>
    <label class="switch"><input type="checkbox" name="hidden" ${asset?.hidden ? 'checked' : ''}/><span class="track"></span><b>${asset?.hidden ? '已屏蔽，不计入合计' : '正常计入合计'}</b></label>
    <span class="hint">屏蔽后：账页里仍保留这条记录，<b>持仓 / 成本 / 行情原样保留</b>，只是不再计入总市值、成本、盈亏、权重；更新行情时会跳过它（行情停在屏蔽那一刻）。随时关掉这个开关就立刻还原，<b>不需要重新拉行情</b>。</span>
  </div>`;

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

  // 记录「名称 / 符号」是否被手动改过：没改过时换代码会自动带出新标的名称
  for (const key of ['name', 'symbol']) {
    const el = form.elements[key];
    el?.addEventListener('input', () => {
      drawer.touched[key] = true;
    });
  }

  // 代码改了就先探一下新标的。之前不做这一步，用户会看到「名字换了、市价还是旧的」而无从判断
  codeInput?.addEventListener('blur', () => {
    const val = codeInput.value.trim();
    const original = String(asset?.code || asset?.coinId || '');
    if (!val || val === original) return;
    lookupAndShow(scope, val);
  });

  updatePreview(scope, asset);
  if (asset && codeInput) lookupAndShow(scope, asset.code || asset.coinId);
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
        if (nameEl && !drawer.touched?.name) nameEl.value = d.dataset.name;
        const symEl = $('#drawerForm').elements.symbol;
        if (symEl && !drawer.touched?.symbol && d.dataset.symbol) symEl.value = d.dataset.symbol;
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
    const form = $('#drawerForm');
    // 只有用户没手动填过名称时才自动带出，避免覆盖他的输入
    if (asset.name && !drawer.touched?.name && form.elements.name) form.elements.name.value = asset.name;
    if (asset.symbol && !drawer.touched?.symbol && form.elements.symbol) form.elements.symbol.value = asset.symbol;
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

  // 代码被改过：明确告知会发生什么，避免出现「名字换了、市价还是旧的」这种误解
  const originalCode = asset ? String(asset.code || asset.coinId || '') : '';
  const codeNow = String(v.code || '').trim();
  const codeSwitched = Boolean(asset && codeNow && codeNow !== originalCode);

  if (asset?.hidden) {
    rows.push(['当前状态', '已屏蔽 · 不计入合计（持仓与行情原样保留）']);
  }

  if (asset?.costMismatch) {
    rows.push(['成本数据异常', `总成本 ${fmt.money(asset.cost)} 与 数量×成本价 ${fmt.money(asset.expectedCost)} 不一致，保存后会自动修正`]);
  }

  if (codeSwitched) {
    rows.push(['代码变更', `${originalCode} → ${codeNow}`]);
    rows.push(['保存后', '清空原有走势与「自上次更新」基准，并按新标的重新取价']);
  }

  if (asset) {
    rows.push([
      codeSwitched ? '原标的行情' : '当前行情',
      live != null ? `${fmt.price(live)}（${asset.priceDate || asset.lastUpdate || '—'}）` : '—',
    ]);
  } else if (live != null) {
    rows.push(['最新行情', fmt.price(live)]);
  } else {
    rows.push(['参考行情', '填写代码后自动获取']);
  }

  if (scope === 'crypto') {
    const cur = v.currency === 'CNY' ? '¥' : '$';
    const rate = v.currency === 'CNY' ? 1 : Number(S.computed.usdCny) || 7.1;
    // 原币（美元）口径为主，人民币一律用实时汇率折算
    const costNative = qty * price;
    const liveNative = live != null ? (v.currency === 'CNY' ? drawer.preview?.priceCny ?? live : live) : null;
    rows.push(['成本（原币）', `${cur}${fmt.num(costNative, 2)}`]);
    rows.push(['人民币成本', `${fmt.money(costNative * rate)}<span class="dim">（汇率 ${rate.toFixed(4)}）</span>`]);
    if (liveNative != null) {
      const pnlNative = qty * (liveNative - price);
      rows.push([
        '按最新价的盈亏',
        `${fmt.signedMoney(pnlNative, cur)} / ${fmt.signedMoney(pnlNative * rate, '¥')}`,
      ]);
    }
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

  pv.classList.toggle('warn', codeSwitched || Boolean(asset?.costMismatch));
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
        if (String(val) !== String(init[k])) data[k] = val;
      }
      if (scope === 'fund') {
        data.dca = {
          enabled: Boolean(v.dcaEnabled),
          amount: Number(v.dcaAmount) || 0,
          startDate: v.dcaStartDate,
        };
        // 勾了才提交，false 时不发，避免误清定投记录
        if (v.resetDca) data.resetDca = true;
      }
      if (data.quantity !== undefined) data.quantity = Number(data.quantity);
      if (data.costPrice !== undefined) data.costPrice = Number(data.costPrice);
      if (data.costAmount !== undefined) data.costAmount = Number(data.costAmount);
      // checkbox 收集出来是布尔值，需要与初始值比较后转成服务端认识的布尔
      if (data.hidden !== undefined) data.hidden = Boolean(data.hidden);
      // 打开时成本就已脱节的记录：保存时顺手修正，用户不必知道要改哪个字段
      const cur = (scope === 'stock' ? S.stocks : scope === 'fund' ? S.funds : S.crypto).find((x) => x.id === drawer.id);
      if (cur?.costMismatch) data.recalcCost = true;
      const res = await api('/api/assets', { method: 'PATCH', body: { scope, id: drawer.id, data } });
      applyState(res.state);
      toast(res.message, [
        `${scope === 'fund' ? '份额' : '数量'} ${fmt.qty(res.asset.quantity)} · 总成本 ${fmt.money(res.asset.costAmount)}`,
        ...(res.refreshed ? [`代码已改为 ${res.asset.code || res.asset.coinId}，旧行情已清空并按新标的取价`] : []),
      ]);
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

/**
 * 一键修正「总成本与 数量×成本价 脱节」的记录。
 * 历史 bug：只改持股数不重算总成本，于是均价 = 总成本 ÷ 数量 变成了第三个值。
 */
async function fixCost(scope, id) {
  const asset = (scope === 'stock' ? S.stocks : scope === 'fund' ? S.funds : S.crypto).find((x) => x.id === id);
  if (!asset) return;
  const ok = window.confirm(
    `把「${asset.name}」的总成本修正为：\n\n    数量 × 成本价 = ${fmt.qty(asset.quantity)} × ${fmt.price(asset.costPrice, 4)} = ${fmt.money(asset.expectedCost)}\n\n` +
      `当前总成本：${fmt.money(asset.cost)}（均价 ${fmt.price(asset.avgCost, 4)}）`,
  );
  if (!ok) return;
  try {
    const res = await api('/api/assets', { method: 'PATCH', body: { scope, id, data: { recalcCost: true } } });
    applyState(res.state);
    toast(`已修正 ${asset.name} 的成本`, [`总成本 ${fmt.money(asset.cost)} → ${fmt.money(asset.expectedCost)}`]);
  } catch (err) {
    toast('修正失败', [err.message], 'err');
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

/** 实时重算的可见/屏蔽划分：屏蔽项不进合计，但仍在表里可见（可标注、可恢复） */
function partition(scope) {
  const all = rowsOfScope(scope);
  return { visible: all.filter((r) => !r.hidden), hidden: all.filter((r) => r.hidden), all };
}

async function runUpdate(scope) {
  const btn = $('#btnUpdate');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  const t0 = Date.now();

  // 与「重建演示」同一套遮罩 + 真实进度。
  // 这里不加延迟：服务端的更新过程已经不再占着数据锁，遮罩一出现就能拿到真实进度，
  // 而且能给用户一个「中止更新」的出口。
  const title = scope === 'all' ? '正在更新全部行情' : `正在更新${SCOPE_META[scope]?.title || ''}行情`;
  const overlayPromise = startBusyPolling(title, '正在连接行情源…', { cancelable: true });

  try {
    const res = await api('/api/update', { method: 'POST', body: { scope } });
    await overlayPromise;
    hideBusy();
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
    if (res.aborted) {
      toast('更新已中止', ['行情与「上次更新」基准都没有变化，可以稍后重试'], 'warn', 6000);
      return;
    }
    for (const rep of reports) {
      const lines = [];
      const label = SCOPE_META[rep.scope]?.title || rep.scope;
      if (rep.summary?.message) lines.push(rep.summary.message);
      if (rep.summary?.updated !== undefined) {
        lines.push(
          `成功 ${rep.summary.updated} 项` +
            (rep.summary.failed ? ` · 失败 ${rep.summary.failed} 项` : '') +
            (rep.summary.skipped ? ` · 已屏蔽跳过 ${rep.summary.skipped} 项` : ''),
        );
      }
      if (rep.summary?.totalChange !== undefined) {
        lines.push(`价格贡献 ${fmt.signed(rep.summary.totalChange)}`);
      }
      if (rep.summary?.dca) {
        const d = rep.summary.dca;
        lines.push(d.applied > 0 ? `定投补算 ${d.applied} 个交易日 · 投入 ${fmt.money(d.amount)} · 新增 ${fmt.qty(d.units)} 份` : '定投：无待补算交易日');
      }
      for (const src of rep.sources || []) {
        if (src.cooling) lines.push(`${src.host} 已熔断，${Math.ceil(src.resumeInMs / 1000)} 秒后重试（${src.reason || '不可用'}）`);
      }
      const dcaItems = (rep.items || []).filter((it) => it.dca?.applied > 0);
      for (const it of dcaItems.slice(0, 3)) {
        const last = it.dca.dates.slice(-3).map((d) => `${d.date} ¥${d.amount}÷${d.nav}=+${d.units}份`);
        lines.push(`${it.name}: ${last.join(' / ')}`);
      }
      const sources = [...new Set((rep.items || []).filter((it) => it.source).map((it) => it.source))];
      if (sources.length) lines.push(`价格来源：${sources.join(' / ')}`);
      toast(`${label}更新完成 · ${((Date.now() - t0) / 1000).toFixed(1)}s`, lines, allErrors.length ? 'warn' : 'ok', 7600);
    }
    if (allErrors.length) {
      toast('部分标的更新失败', allErrors.slice(0, 5).map((e) => `${e.name}: ${e.message}`), 'err', 9000);
    }
  } catch (err) {
    await overlayPromise.catch(() => {});
    hideBusy();
    toast('更新失败', [err.message], 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
  }
}

/**
 * 中止更新。
 *
 * 服务端在每个标的开工前、以及每个源的循环里都会检查中止信号，
 * 所以点下去之后**当前这一只**请求跑完就会停，不会把剩下的标的继续跑完。
 * 拿到响应前先把按钮锁住并改文案，避免用户以为没反应而连点。
 */
async function cancelUpdate() {
  const btn = $('#busyCancel');
  const label = $('#busyLabel');
  const title = $('#busyTitle');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在中止…';
  }
  // 立刻在遮罩上给反馈：正在飞的这一个请求要跑完才会停
  if (title) title.textContent = '正在中止更新';
  if (label) label.textContent = '等待当前这一项请求结束…';
  stopBusyPolling();
  try {
    const res = await api('/api/update/cancel', { method: 'POST' });
    if (label) label.textContent = res.cancelled ? '正在中止，稍候…' : '当前没有进行中的更新';
  } catch {
    /* 没赶上也无所谓，更新结束时遮罩会自己收起来 */
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '中止更新';
      }
      // 更新还在跑的话把进度轮询接回去，别让遮罩停在「正在中止」
      if (!$('#busy').hidden) startBusyPolling('正在更新行情', '正在收尾…', { cancelable: true });
    }, 2000);
  }
}

/* ============================================================ 启动 */

async function boot() {
  initContrast();
  loadSortState();
  loadShowHidden();
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => switchTab(n.dataset.tab)));
  $('#btnUpdate').addEventListener('click', () => runUpdate(tab === 'overview' ? 'all' : tab));
  $('#busyCancel').addEventListener('click', cancelUpdate);
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
