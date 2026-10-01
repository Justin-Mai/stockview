/**
 * 本地 JSON 存储层。
 * 数据落在 <项目根>/data/portfolio.json，写入采用「临时文件 + rename」保证原子性。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORY_CAP, nowStamp } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'portfolio.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

export function emptyState() {
  return {
    version: 1,
    createdAt: nowStamp(),
    updatedAt: nowStamp(),
    meta: {
      lastUpdate: { stock: null, fund: null, crypto: null },
      usdCny: null,
      usdCnyAt: null,
      /** 行情快照时间 */
      quoteAt: null,
    },
    stocks: [],
    funds: [],
    crypto: [],
    logs: [],
  };
}

/** 走势序列只保留最近 HISTORY_CAP 条（顺带按日期升序、去重） */
function capHistory(asset) {
  if (!asset || !Array.isArray(asset.history)) return asset;
  if (asset.history.length === 0) return asset;
  const seen = new Map();
  for (const it of asset.history) if (it && it.date) seen.set(it.date, it);
  const sorted = [...seen.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (sorted.length > HISTORY_CAP || sorted.length !== asset.history.length) {
    asset.history = sorted.slice(-HISTORY_CAP);
  }
  return asset;
}

/** 保证数组/对象结构完整（兼容手工改动过的 JSON），并顺手裁剪膨胀的走势数组 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const state = {
    ...base,
    ...raw,
    meta: { ...base.meta, ...(raw.meta || {}), lastUpdate: { ...base.meta.lastUpdate, ...(raw.meta?.lastUpdate || {}) } },
  };
  state.stocks = Array.isArray(raw.stocks) ? raw.stocks : [];
  state.funds = Array.isArray(raw.funds) ? raw.funds : [];
  state.crypto = Array.isArray(raw.crypto) ? raw.crypto : [];
  state.logs = Array.isArray(raw.logs) ? raw.logs.slice(-600) : [];
  // 历史版本 / 手工改过的 JSON 里没有 hidden 字段，统一收敛成布尔值
  for (const list of [state.stocks, state.funds, state.crypto]) {
    for (const asset of list) asset.hidden = Boolean(asset.hidden);
  }
  // 历史版本 / 演示数据可能写入过全量净值序列（数千条），在这里统一收口
  for (const list of [state.stocks, state.funds, state.crypto]) {
    for (const asset of list) capHistory(asset);
  }
  return state;
}

let queue = Promise.resolve();

/** 串行化读写，避免并发请求把文件写坏 */
function serialize(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

export async function load() {
  return serialize(async () => {
    try {
      const text = await fs.readFile(DATA_FILE, 'utf8');
      return normalizeState(JSON.parse(text));
    } catch (err) {
      if (err.code === 'ENOENT') return emptyState();
      // 文件损坏：留档后重建，保证程序能启动
      if (err instanceof SyntaxError) {
        await fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {});
        const stamp = new Date().toISOString().replaceAll(':', '-');
        await fs.copyFile(DATA_FILE, path.join(BACKUP_DIR, `broken-${stamp}.json`)).catch(() => {});
        return emptyState();
      }
      throw err;
    }
  });
}

export async function save(state) {
  return serialize(async () => {
    const next = { ...state, updatedAt: nowStamp() };
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE);
    return next;
  });
}

/** 读 → 改 → 写 的原子事务 */
export async function mutate(fn) {
  return serialize(async () => {
    let state;
    try {
      const text = await fs.readFile(DATA_FILE, 'utf8');
      state = normalizeState(JSON.parse(text));
    } catch (err) {
      if (err.code === 'ENOENT') state = emptyState();
      else if (err instanceof SyntaxError) state = emptyState();
      else throw err;
    }
    const result = await fn(state);
    const next = { ...state, updatedAt: nowStamp() };
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE);
    return { state: next, result };
  });
}

/**
 * 把当前数据文件复制一份到 data/backups/。
 * 用于「导入 / 清空 / 重建演示」这类破坏性操作之前 —— 出事有得回退。
 * @returns {Promise<string|null>} 备份文件路径；原本没有数据文件时返回 null
 */
export async function backupNow(tag = 'backup') {
  let text;
  try {
    text = await fs.readFile(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `${tag}-${stamp}.json`);
  await fs.writeFile(file, text, 'utf8');
  return file;
}

export const paths = { DATA_DIR, DATA_FILE, BACKUP_DIR };
