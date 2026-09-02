/**
 * SyncQueue: 按 "<provider>:<owner>/<repo>:<branch>" 隔离的串行队列。
 * 规则(2.0 方案 §8):
 * - 同一键同一时刻只运行一个同步任务;
 * - 可合并的触发(自动同步)在任务运行中时只记录合并,不创建并行任务;
 * - 手动/冲突解决任务在当前任务结束后依次执行;
 * - 不同仓库分支可并行。
 */

import { SyncError, SyncErrorCategory } from "./sync-error.js";

export class SyncQueue {
  constructor() {
    /** @type {Map<string, {running:boolean, pending:number, chain:Promise}>} */
    this.lanes = new Map();
    this.events = null; // 可选注入 event bus
  }

  static keyOf({ provider, owner, repo, branch }) {
    return provider + ":" + owner + "/" + repo + ":" + branch;
  }

  /**
   * 入队一个任务。
   * @returns {Promise<{merged:boolean, queued:boolean, result:any}>}
   *   merged=true 表示该触发被合并进运行中/已排队的任务,未创建新任务。
   */
  enqueue(key, task, { mergeable = false, label = "" } = {}) {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: false, pending: 0, chain: Promise.resolve() };
      this.lanes.set(key, lane);
    }
    // 同步判定: 已有任务在运行或已排队 → 可合并触发直接合并,不追加
    if (mergeable && (lane.running || lane.pending > 0)) {
      if (this.events) this.events.emit("queue:merged", { key, label });
      return Promise.resolve({ merged: true, queued: false, result: null });
    }
    lane.pending += 1;
    const execution = lane.chain.then(
      () => this._run(key, lane, task, label),
      () => this._run(key, lane, task, label) // 前任失败不阻塞后续任务
    );
    lane.chain = execution.catch(() => {});
    return execution.then((r) => ({ merged: false, queued: true, result: r }));
  }

  async _run(key, lane, task, label) {
    lane.pending -= 1;
    lane.running = true;
    if (this.events) this.events.emit("queue:start", { key, label });
    try {
      return await task();
    } finally {
      lane.running = false;
      if (this.events) this.events.emit("queue:finish", { key, label });
      if (lane.pending <= 0) {
        // 空闲后清理,避免 Map 无限增长
        const timer = setTimeout(() => {
          if (!lane.running && lane.pending <= 0) this.lanes.delete(key);
        }, 0);
        if (typeof timer.unref === "function") timer.unref();
      }
    }
  }

  isRunning(key) {
    const lane = this.lanes.get(key);
    return !!(lane && lane.running);
  }

  /** 包装任务: 任何异常统一转 SyncError 上抛,保持错误可分类 */
  static wrapError(phase) {
    return (task) => async () => {
      try {
        return await task();
      } catch (err) {
        if (err instanceof SyncError) throw err;
        throw new SyncError({
          category: SyncErrorCategory.UNKNOWN,
          phase,
          message: (err && err.message) || String(err),
          detail: (err && err.stack) || "",
          cause: err,
        });
      }
    };
  }
}
