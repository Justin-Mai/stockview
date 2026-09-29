/**
 * 通用工具：日期（统一 Asia/Shanghai）、数值精度、ID。
 * 全部按 A 股交易日所在的东八区计算，避免本机时区不在中国时算错一天。
 */

const TZ = 'Asia/Shanghai';

/**
 * 每只标的保留的走势点数上限。
 * 基金净值接口返回的是「成立以来全量」（老基金可达数千条），必须截断后再落盘，
 * 否则 portfolio.json 会被撑到几百 KB 且每次读写都变慢。
 */
export const HISTORY_CAP = 180;

/** 取东八区“现在”的日期时间片段 */
function shanghaiParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  // en-CA 的 hour 可能给出 "24"
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** 东八区今日 YYYY-MM-DD */
export function today() {
  const p = shanghaiParts();
  return `${p.year}-${p.month}-${p.day}`;
}

/** 东八区现在 YYYY-MM-DD HH:mm:ss */
export function nowStamp() {
  const p = shanghaiParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 东八区今日 YYYYMMDD */
export function todayCompact() {
  return today().replaceAll('-', '');
}

/** 任意输入 → YYYY-MM-DD（非法/空返回 null） */
export function toDateStr(value) {
  if (!value) return null;
  if (value instanceof Date) return dateFromParts(shanghaiParts(value));
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return dateFromParts(shanghaiParts(d));
  return null;
}

function dateFromParts(p) {
  return `${p.year}-${p.month}-${p.day}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD → YYYYMMDD */
export function compact(dateStr) {
  return dateStr ? String(dateStr).replaceAll('-', '') : null;
}

/** YYYYMMDD → YYYY-MM-DD */
export function expand(dateCompact) {
  const s = String(dateCompact ?? '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return toDateStr(s);
}

/** 日期加减天数，返回 YYYY-MM-DD */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** a - b 的整天数（a 晚于 b 为正） */
export function dayDiff(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((ta - tb) / 86400000);
}

/** a 是否晚于 b */
export function isAfter(a, b) {
  return a && b ? a > b : false;
}

/** 保留小数位，避免浮点尾数 */
export function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 0;
  const f = 10 ** dp;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

/** 安全数字 */
export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 生成短 ID */
export function makeId(prefix = 'a') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 简易并发映射（限制并发数，保持输出顺序） */
export async function mapLimit(items, limit, worker) {
  const list = [...items];
  const out = new Array(list.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, list.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < list.length) {
        const i = cursor++;
        out[i] = await worker(list[i], i);
      }
    }),
  );
  return out;
}

/**
 * 带 TTL 的异步记忆化。
 * 注意必须按「参数」分别缓存：早期版本只存了一个值，
 * 导致 getPrices(['bitcoin']) 之后 getPrices(['ethereum']) 会拿到 bitcoin 的结果。
 */
export function memo(fn, ttlMs = 60_000, maxEntries = 60) {
  const cache = new Map(); // key -> { value, at }
  const inflight = new Map(); // key -> Promise

  return async (...args) => {
    const key = JSON.stringify(args);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (inflight.has(key)) return inflight.get(key);

    const pending = Promise.resolve()
      .then(() => fn(...args))
      .then((value) => {
        cache.set(key, { value, at: Date.now() });
        if (cache.size > maxEntries) {
          const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) cache.delete(oldest[0]);
        }
        return value;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, pending);
    return pending;
  };
}
