/**
 * NotificationService: 通知策略(2.0 方案 §9.2)。
 * - toast 去重: 同一会话同一文案连续出现只提示一次;
 * - 顶栏徽标: 同步中旋转 / 成功绿点 / 失败红点 / 冲突暂停红色闪烁;
 * - 自动触发失败只在首次提示,不打扰;
 * - 所有通知走宿主 showMessage,不弹系统级通知。
 */

export class NotificationService {
  constructor({ q, i18n, stateFile = "notify-state.json" } = {}) {
    this.q = q;
    this.i18n = i18n;
    this.topBarElement = null;
    this._lastToastText = "";
    this._autoFailNotified = false;
  }

  setTopBarElement(el) {
    this.topBarElement = el;
  }

  /** 基础 toast(带同文案去重) */
  toast(text, type = "info", timeout = 3000) {
    if (!this.q || typeof this.q.showMessage !== "function") return;
    if (text && text === this._lastToastText) return;
    this._lastToastText = text;
    setTimeout(() => {
      if (text === this._lastToastText) this._lastToastText = "";
    }, timeout + 1000);
    this.q.showMessage(text, timeout, type);
  }

  /** 手动触发: 开始同步始终可见 */
  syncStarted(trigger) {
    if (trigger === "automatic") return; // 自动触发不提示开始
    this.toast((this.i18n && this.i18n.gSyncStartMsg) || "🔄 开始同步…", "info");
    this._badge("syncing");
  }

  syncSuccess(result, { automatic = false, successNotify = true } = {}) {
    const detail = result
      ? " (↑" + (result.uploads || 0) + " ↓" + (result.downloads || 0) + " 删远" + (result.deletionsRemote || 0) + " 删本" + (result.deletionsLocal || 0) + ")"
      : "";
    if (automatic) {
      if (successNotify) this.toast((this.i18n && this.i18n.gSyncSuccessMsg) || "✅ 同步成功" + detail, "info");
    } else {
      this.toast((this.i18n && this.i18n.gSyncSuccessMsg) || "✅ 同步成功" + detail, "info");
    }
    this._badge("success");
  }

  syncError(syncErr, { automatic = false } = {}) {
    const summary = syncErr && syncErr.toDisplayText ? syncErr.toDisplayText() : String((syncErr && syncErr.message) || syncErr);
    if (automatic && this._autoFailNotified && this._lastAutoFailCategory === syncErr.category) {
      // 同类自动失败只提示一次,后续仅记录
    } else {
      this._autoFailNotified = automatic || this._autoFailNotified;
      this._lastAutoFailCategory = syncErr.category;
      this.toast("❌ " + summary, "error", 6000);
    }
    this._badge("error");
  }

  conflictPaused({ kind, conflictCount, reason } = {}) {
    const isBase = kind === "BASE_UNRESOLVED";
    const text = isBase
      ? (this.i18n && this.i18n.sygspBaseUnresolvedMsg) || "🔴 同步基准无法确认,自动同步已暂停,请打开插件菜单处理"
      : (this.i18n && this.i18n.gSyncConflictMsg) || "🔴 检测到同步冲突,自动同步已暂停";
    this.toast(conflictCount ? text + "(" + conflictCount + " 个文件)" : text, "error", 6000);
    this._badge("conflict");
  }

  conflictResolved() {
    this.toast((this.i18n && this.i18n.gSyncResolvedMsg) || "✅ 冲突已处理,自动同步已恢复", "info");
    this._badge("success");
  }

  pausedAutoSkip() {
    this.toast((this.i18n && this.i18n.gSyncPausedMsg) || "⚠️ 同步冲突未解决,自动同步已暂停,请处理冲突", "error");
  }

  _badge(kind) {
    const el = this.topBarElement;
    if (!el || !el.classList) return;
    el.classList.remove("git-syncing", "git-sync-success", "git-sync-failed", "git-sync-conflict-paused");
    if (kind === "syncing") el.classList.add("git-syncing");
    else if (kind === "success") el.classList.add("git-sync-success");
    else if (kind === "error") el.classList.add("git-sync-failed");
    else if (kind === "conflict") el.classList.add("git-sync-conflict-paused");
  }
}
