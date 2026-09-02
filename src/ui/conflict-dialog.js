/**
 * ConflictDialog: 冲突处理弹窗(2.0 方案 §7.6)。
 * - 逐文件决策(保留本地/保留远端/稍后) + 批量决策;
 * - 显示冲突原因;「打开冲突副本」提供定位提示;
 * - 决策提交后由控制器重新规划执行;取消则保持暂停。
 */

import { SyncError, SyncErrorCategory } from "../sync/sync-error.js";

export class ConflictDialog {
  /**
   * @param {object} deps {q, i18n, conflictService, onDecide(async decisionsMap), notify}
   */
  constructor(deps) {
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.conflictService = deps.conflictService;
    this.onDecide = deps.onDecide;
    this.notify = deps.notify;
    this.dialog = null;
    this.set = null;
  }

  /** 展示一个冲突集;conflictSet 为 ConflictService.saveSet 返回值 */
  show(conflictSet) {
    const q = this.q;
    this.set = conflictSet;
    const t = this.i18n;
    this.dialog = new q.Dialog({
      title: (t && t.gSyncConflictTitle) || "⚠️ 检测到同步冲突",
      content: '<div id="sygspConflictDialog" class="fn__flex-column" style="padding:16px;gap:8px;"></div>',
      width: "720px",
      height: "60vh",
      destroyCallback: () => {
        this.dialog = null;
      },
    });
    const root = this.dialog.element.querySelector("#sygspConflictDialog");
    this._render(root, conflictSet);
  }

  close() {
    if (this.dialog) {
      this.dialog.destroy();
      this.dialog = null;
    }
  }

  _render(root, set) {
    const t = this.i18n;
    root.textContent = "";

    const desc = document.createElement("div");
    desc.className = "b3-label__text";
    desc.textContent = (t && t.gSyncConflictDesc) || "本地与远端的数据同时被修改,自动同步已暂停。请选择处理方式:";
    root.appendChild(desc);

    const count = document.createElement("div");
    count.className = "ft__on-surface";
    count.textContent = (t && t.sygspConflictCount) || "冲突文件" + ": " + set.conflicts.length;
    root.appendChild(count);

    const list = document.createElement("div");
    list.className = "fn__flex-1";
    list.style.overflow = "auto";
    for (const conflict of set.conflicts) {
      list.appendChild(this._conflictRow(conflict));
    }
    root.appendChild(list);

    root.appendChild(this._actionBar(set));
  }

  _conflictRow(conflict) {
    const t = this.i18n;
    const row = document.createElement("div");
    row.className = "b3-label";
    row.dataset.path = conflict.path;

    const pathLine = document.createElement("div");
    pathLine.className = "fn__flex";
    pathLine.style.alignItems = "center";
    const name = document.createElement("span");
    name.className = "fn__flex-1 ft__breakword";
    name.textContent = conflict.path;
    pathLine.appendChild(name);
    row.appendChild(pathLine);

    const reason = document.createElement("div");
    reason.className = "b3-label__text";
    reason.textContent = conflict.reason || "";
    row.appendChild(reason);

    const buttons = document.createElement("div");
    buttons.className = "fn__flex fn__flex-wrap";
    buttons.style.gap = "8px";
    buttons.appendChild(this._btn((t && t.gSyncKeepLocal) || "保留本地版本", () => this._decideOne(conflict.path, "keep_local")));
    buttons.appendChild(this._btn((t && t.gSyncKeepRemote) || "保留远端版本", () => this._decideOne(conflict.path, "keep_remote")));
    if (conflict.snapshots && (conflict.snapshots.localB64 || conflict.snapshots.remoteB64)) {
      buttons.appendChild(this._btn((t && t.sygspExportCopies) || "导出三方副本", () => this._exportCopies(conflict)));
    }
    row.appendChild(buttons);
    return row;
  }

  _actionBar(set) {
    const t = this.i18n;
    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.gap = "8px";
    bar.appendChild(this._btn((t && t.sygspKeepAllLocal) || "全部保留本地", () => this._decideAll("keep_local"), "b3-button b3-button--text"));
    bar.appendChild(this._btn((t && t.sygspKeepAllRemote) || "全部保留远端", () => this._decideAll("keep_remote"), "b3-button b3-button--text"));
    const spacer = document.createElement("div");
    spacer.className = "fn__flex-1";
    bar.appendChild(spacer);
    bar.appendChild(this._btn((t && t.gSyncLater) || "稍后处理", () => this.close(), "b3-button b3-button--cancel"));
    return bar;
  }

  _btn(label, onClick, cls = "b3-button b3-button--outline") {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  async _decideOne(path, decision) {
    await this.conflictService.decide(this.set.operationId, path, decision);
    this.set.conflicts = this.set.conflicts.filter((c) => c.path !== path);
    if (this.dialog && this.dialog.element) {
      const root = this.dialog.element.querySelector("#sygspConflictDialog");
      this._render(root, this.set);
    }
    await this._flushIfAllDecided();
  }

  async _decideAll(decision) {
    for (const conflict of [...this.set.conflicts]) {
      await this.conflictService.decide(this.set.operationId, conflict.path, decision);
    }
    this.set.conflicts = [];
    this.close();
    await this._flushIfAllDecided();
  }

  async _flushIfAllDecided() {
    const overrides = this.conflictService.collectOverrides(this.set.operationId);
    if (overrides.size === 0) return;
    if (this.dialog) this.close();
    try {
      await this.onDecide(overrides);
    } catch (err) {
      const msg = (err && (err.message || err.toString())) || String(err);
      this.notify("❌ " + ((this.i18n && this.i18n.gSyncResolveFailedMsg) || "处理冲突的同步失败,冲突仍待处理") + ": " + msg, "error");
    }
  }

  async _exportCopies(conflict) {
    try {
      const dir = "temp/SY-GSP/conflicts/" + this.set.operationId + "/";
      const stem = conflict.path.replace(/\//g, "_");
      const writes = [];
      if (conflict.snapshots && conflict.snapshots.baseB64) {
        writes.push([dir + stem + ".base", conflict.snapshots.baseB64]);
      }
      if (conflict.snapshots && conflict.snapshots.localB64) {
        writes.push([dir + stem + ".local", conflict.snapshots.localB64]);
      }
      if (conflict.snapshots && conflict.snapshots.remoteB64) {
        writes.push([dir + stem + ".remote", conflict.snapshots.remoteB64]);
      }
      for (const [path, b64] of writes) {
        const bytes = base64ToBytes(b64);
        await this._putFile(path, bytes);
      }
      const t = this.i18n;
      this.notify(((t && t.sygspExportCopiesDone) || "已导出到") + " " + dir, "info");
    } catch (err) {
      this.notify("❌ " + String((err && err.message) || err), "error");
    }
  }

  async _putFile(path, bytes) {
    // 由宿主注入的 kernel 能力;测试环境替换
    if (!this._kernel) {
      throw new SyncError({ category: SyncErrorCategory.LOCAL_FILE, message: "内核能力未注入" });
    }
    await this._kernel.putFile(path, new Blob([bytes]), false);
  }

  setKernel(kernel) {
    this._kernel = kernel;
  }
}

function base64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
