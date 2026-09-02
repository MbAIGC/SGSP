/**
 * DiagnosisPanel: 只读诊断 / 首次同步向导 / 基准恢复向导(2.0 方案 §11/§12)。
 * - 诊断项全部只读,不写入任何数据;
 * - 首次写入前展示同步计划预览(上传/下载/删除/冲突计数),确认后才放行;
 * - BASE_UNRESOLVED 时提供「以下载远端为准 / 以上传本地为准 / 取消」。
 */

export class DiagnosisPanel {
  /**
   * @param {object} deps {q, i18n, runChecks: async () => [{name, ok, detail}],
   *   previewPlan: async () => {uploads, downloads, deletionsRemote, deletionsLocal, conflicts, skippedDeletes},
   *   onChooseBase: async ("keep_local"|"keep_remote") => void,
   *   onFirstWriteConfirmed: async () => void,
   *   notify}
   */
  constructor(deps) {
    this.q = deps.q;
    this.i18n = deps.i18n;
    this.runChecks = deps.runChecks;
    this.previewPlan = deps.previewPlan;
    this.onChooseBase = deps.onChooseBase;
    this.onFirstWriteConfirmed = deps.onFirstWriteConfirmed;
    this.notify = deps.notify;
    this.dialog = null;
  }

  show({ mode = "diagnosis" } = {}) {
    const q = this.q;
    const t = this.i18n;
    this.dialog = new q.Dialog({
      title: (t && t.sygspDiagnosisTitle) || "SY-GSP 只读诊断",
      content: '<div id="sygspDiagnosis" class="fn__flex-column" style="padding:16px;gap:8px;"></div>',
      width: "640px",
      height: "70vh",
      destroyCallback: () => {
        this.dialog = null;
      },
    });
    const root = this.dialog.element.querySelector("#sygspDiagnosis");
    this._renderLoading(root);
    this._run(mode, root);
  }

  close() {
    if (this.dialog) {
      this.dialog.destroy();
      this.dialog = null;
    }
  }

  async _run(mode, root) {
    const checks = await this._safe(this.runChecks);
    this._render(root, mode, checks);
  }

  async _safe(fn) {
    try {
      return (await fn()) || [];
    } catch (err) {
      return [{ name: "诊断执行失败", ok: false, detail: String((err && err.message) || err) }];
    }
  }

  _renderLoading(root) {
    root.textContent = "";
    const loading = document.createElement("div");
    loading.className = "fn__loading";
    loading.innerHTML = '<img width="64px" src="/stage/loading-pure.svg"/>'; // 静态骨架,无动态数据
    root.appendChild(loading);
  }

  async _render(root, mode, checks) {
    const t = this.i18n;
    root.textContent = "";

    const title = document.createElement("div");
    title.className = "b3-label";
    title.textContent = (t && t.sygspDiagnosisDesc) || "以下检查均为只读操作,不会修改本地或远端数据";
    root.appendChild(title);

    for (const check of checks) {
      const row = document.createElement("div");
      row.className = "b3-label";
      const line = document.createElement("div");
      line.className = "fn__flex";
      const icon = document.createElement("span");
      icon.textContent = check.ok ? "✅" : "❌";
      icon.style.marginRight = "6px";
      const name = document.createElement("span");
      name.textContent = check.name;
      line.appendChild(icon);
      line.appendChild(name);
      row.appendChild(line);
      if (check.detail) {
        const detail = document.createElement("div");
        detail.className = "b3-label__text ft__breakword";
        detail.textContent = check.detail;
        row.appendChild(detail);
      }
      root.appendChild(row);
    }

    if (mode === "base_recovery") {
      root.appendChild(this._baseRecoveryActions());
    } else if (mode === "first_sync") {
      root.appendChild(await this._firstSyncPreview());
    }
  }

  _baseRecoveryActions() {
    const t = this.i18n;
    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.gap = "8px";
    const warn = document.createElement("div");
    warn.className = "b3-label__text fn__flex-1";
    warn.textContent = (t && t.sygspBaseRecoveryWarn) || "本地与远端无法证明共同基准。选择一侧为准后执行一次覆盖同步(被覆盖侧的冲突副本会导出备份):";
    bar.appendChild(warn);
    bar.appendChild(this._btn((t && t.sygspChooseRemote) || "以下载远端为准", () => this._choose("keep_remote")));
    bar.appendChild(this._btn((t && t.sygspChooseLocal) || "以上传本地为准", () => this._choose("keep_local")));
    bar.appendChild(this._btn((t && t.cancel) || "取消", () => this.close(), "b3-button b3-button--cancel"));
    return bar;
  }

  async _firstSyncPreview() {
    const t = this.i18n;
    const box = document.createElement("div");
    box.className = "b3-label fn__flex-column";
    box.style.gap = "6px";
    const title = document.createElement("div");
    title.textContent = (t && t.sygspPreviewTitle) || "首次写入前的同步计划预览:";
    box.appendChild(title);

    const preview = await this._safe(this.previewPlan);
    for (const item of preview) {
      const line = document.createElement("div");
      line.className = "b3-label__text";
      line.textContent = item.name + ": " + item.detail;
      box.appendChild(line);
    }
    const actions = document.createElement("div");
    actions.className = "fn__flex";
    actions.style.gap = "8px";
    const confirm = this._btn((t && t.sygspConfirmFirstWrite) || "确认并开始首次同步", async () => {
      try {
        await this.onFirstWriteConfirmed();
        this.notify((t && t.sygspFirstWriteConfirmed) || "✅ 已确认,开始执行首次同步", "info");
        this.close();
      } catch (err) {
        this.notify("❌ " + String((err && err.message) || err), "error");
      }
    }, "b3-button b3-button--text");
    actions.appendChild(confirm);
    actions.appendChild(this._btn((t && t.cancel) || "取消", () => this.close(), "b3-button b3-button--cancel"));
    box.appendChild(actions);
    return box;
  }

  _choose(choice) {
    this.close();
    Promise.resolve(this.onChooseBase(choice)).catch((err) => {
      this.notify("❌ " + String((err && err.message) || err), "error");
    });
  }

  _btn(label, onClick, cls = "b3-button b3-button--outline") {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }
}
