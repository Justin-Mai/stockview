/**
 * 单任务进度追踪。
 *
 * 用于「重建演示数据」这类要联网、耗时数秒的操作：
 * 前端点击后立刻显示遮罩，并轮询 /api/task 拿到真实进度文案，
 * 而不是干等一个转圈——用户能看到程序当前正在抓哪个标的。
 *
 * 本应用是单人本地使用，同一时刻只会有一个长任务，因此用模块级单例即可。
 */

let task = null;

/**
 * 开始一个任务
 * @param {string} title 任务标题
 * @param {number} total 总步数
 */
export function beginTask(title, total = 1) {
  task = {
    title,
    label: title,
    step: 0,
    total: Math.max(1, total),
    active: true,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    lines: [],
  };
  return task;
}

/**
 * 汇报进度
 * @param {number|object} stepOrPatch 步数，或 { step, label, title }
 */
export function reportProgress(stepOrPatch) {
  if (!task || !task.active) return task;
  if (typeof stepOrPatch === 'number') {
    task.step = Math.min(stepOrPatch, task.total);
    return task;
  }
  const { step, label, total } = stepOrPatch || {};
  if (label && label !== task.label) {
    task.label = label;
    task.lines.push(label);
    if (task.lines.length > 60) task.lines.shift();
  }
  if (typeof step === 'number') task.step = Math.min(step, task.total);
  if (typeof total === 'number') task.total = Math.max(task.total, total);
  return task;
}

/** 结束任务（error 传 null 表示成功） */
export function endTask(error = null) {
  if (!task) return task;
  task.active = false;
  task.error = error ? String(error.message || error) : null;
  task.finishedAt = Date.now();
  task.label = task.error ? `失败：${task.error}` : '已完成';
  return task;
}

/** 当前任务快照（含耗时，供前端显示） */
export function currentTask() {
  if (!task) return { active: false, idle: true };
  const end = task.finishedAt || Date.now();
  return { ...task, elapsedMs: end - task.startedAt };
}
