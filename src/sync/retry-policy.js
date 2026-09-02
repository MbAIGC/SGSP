/**
 * RetryPolicy: 只对幂等、可判定且不会扩大写入风险的错误自动重试(2.0 方案 §7.8)。
 * - NETWORK/TIMEOUT: 最多 3 次,延迟 1s/3s/9s + 小幅随机抖动;
 * - REMOTE_CHANGED/PUSH_REJECTED: 最多 2 次,每次必须重新规划(由引擎重新执行,这里只判定资格);
 * - 其余(AUTH/PERMISSION/REPOSITORY/BRANCH/LARGE_FILE/CONFLICT/...)不自动重试。
 */

import { SyncErrorCategory } from "./sync-error.js";
import { SyncError } from "./sync-error.js";

const NETWORK_MAX = 3;
const REMOTE_CHANGED_MAX = 2;
const BASE_DELAYS_MS = [1000, 3000, 9000];

/** 默认允许自动重试的错误类别(诊断/设置说明引用) */
export const DEFAULT_RETRYABLE_CATEGORIES = Object.freeze([
  SyncErrorCategory.NETWORK,
  SyncErrorCategory.TIMEOUT,
  SyncErrorCategory.REMOTE_CHANGED,
  SyncErrorCategory.PUSH_REJECTED,
]);

const NO_RETRY_CATEGORIES = [
  SyncErrorCategory.AUTH,
  SyncErrorCategory.PERMISSION,
  SyncErrorCategory.REPOSITORY,
  SyncErrorCategory.BRANCH,
  SyncErrorCategory.LARGE_FILE,
  SyncErrorCategory.CONFLICT,
  SyncErrorCategory.LOCAL_FILE,
  SyncErrorCategory.CANCELLED,
];

export class RetryPolicy {
  constructor({ enabled = false } = {}) {
    this.enabled = !!enabled;
  }

  /**
   * 判定某错误是否可重试。
   * @param {SyncError|Error} err
   * @param {number} attempt 已尝试次数(从 0 开始)
   * @returns {{retry:boolean, delayMs:number, replan:boolean, reason:string}}
   */
  decide(err, attempt) {
    const category = (err && err.category) || "";
    const notEligible = (reason) => ({ retry: false, delayMs: 0, replan: false, reason });

    if (!this.enabled) return notEligible("自动重试未开启");
    if (!(err instanceof SyncError)) return notEligible("非 SyncError");
    if (NO_RETRY_CATEGORIES.indexOf(category) >= 0) return notEligible("该错误类型不自动重试");
    if (err.retryable === false) return notEligible("错误标记为不可重试");

    if (category === SyncErrorCategory.NETWORK || category === SyncErrorCategory.TIMEOUT) {
      if (attempt >= NETWORK_MAX) return notEligible("已达网络类重试上限");
      return { retry: true, delayMs: this._delay(attempt), replan: false, reason: "网络类暂态错误" };
    }
    if (category === SyncErrorCategory.REMOTE_CHANGED || category === SyncErrorCategory.PUSH_REJECTED) {
      if (attempt >= REMOTE_CHANGED_MAX) return notEligible("已达远端变化重试上限");
      // 重试必须重新读取远端 HEAD、重新计算计划,不允许复用旧 tree/commit
      return { retry: true, delayMs: 0, replan: true, reason: "远端已变化,重新规划" };
    }
    return notEligible("未知重试资格");
  }

  _delay(attempt) {
    const base = BASE_DELAYS_MS[Math.min(attempt, BASE_DELAYS_MS.length - 1)];
    const jitter = Math.round(base * 0.2 * Math.random());
    return base + jitter;
  }
}
