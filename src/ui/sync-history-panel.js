/**
 * SY-GSP 同步历史面板。纯 DOM（无框架/依赖/import），复用思源 b3-* / fn__* / ft__* 工具类。
 * 顶栏筛选＋左 320px 提交列表（滚动自动翻页）＋右文件列表＋底部提交版本 vs 本地版本对比；异步请求显示 fn__loading 遮罩。
 */
export class SyncHistoryPanel {
  static PER_PAGE = 50;
  // 变更状态 → i18n 键与配色（新增/修改/删除/重命名）
  static STATUS_MAP = {
    added: { key: "statusAdded", cls: "ft__success" },
    modified: { key: "statusModified", cls: "ft__primary" },
    removed: { key: "statusRemoved", cls: "ft__error" },
    renamed: { key: "statusRenamed", cls: "ft__warning" },
  };
  constructor(opts) {
    this._opts = opts;
    this._i18n = opts.i18n || {};
    this._provider = opts.provider || {};
    this._abort = new AbortController();
    this._destroyed = false;
    this._commits = [];      // 已加载提交（新→旧）
    this._page = 0;          // 下一页序号
    this._hasMore = true;    // 返回条数不足 perPage 后停止翻页
    this._startRef = "";     // 起点：本地=localCommitSha，远端=分支名
    this._dataSource = "0";  // 0=本地提交(默认)，1=远端提交
    this._selectedSha = "";
    this._loadingCommits = false;
    // 请求序号：丢弃过期响应；loading 遮罩与空态占位按容器计数/记忆
    this._commitsSeq = 0;
    this._filesSeq = 0;
    this._loadingCount = new Map();
    this._loadingOverlays = new Map();
    this._placeholders = new WeakMap();
    this._buildDom();
    this._bindEvents();
    this._init();
  }
  /** 释放：取消全部事件监听（AbortController signal），移除残留遮罩 */
  destroy() {
    this._destroyed = true;
    if (this._abort) this._abort.abort();
    for (const o of this._loadingOverlays.values()) o.remove();
    this._loadingOverlays.clear();
    this._loadingCount.clear();
  }

  // ─────────── 初始化 ───────────
  async _init() {
    if (this._destroyed) return;
    this._setPlaceholder(this._filesEl, this._i18n.selectCommitHint);
    this._showLoading(this._rootEl);
    try { await this._fillNotebooks(); }
    catch (err) { this._notifyFail(err, this._i18n.loadFailed); }
    finally { this._hideLoading(this._rootEl); }
    await this._reloadCommits();
  }
  /** 笔记本下拉：首项 value="" 全部，其余 value=data/<id> */
  async _fillNotebooks() {
    const list = await this._opts.listNotebooks();
    const notebooks = Array.isArray(list) ? list : [];
    this._notebookSelect.textContent = "";
    const all = this._option("", this._i18n.allNotebookName);
    all.title = this._i18n.allNotebooks; // 提示：筛选范围为整个工作空间
    this._notebookSelect.appendChild(all);
    for (const nb of notebooks) {
      if (!nb || !nb.id) continue;
      this._notebookSelect.appendChild(this._option("data/" + nb.id, nb.name || nb.id));
    }
  }

  // ─────────── DOM 骨架 ───────────
  _buildDom() {
    const i18n = this._i18n;
    const root = this._el("div", "history__root fn__flex fn__flex-column", "height:100%;min-height:0;box-sizing:border-box");
    const toolbar = this._el("div", "history__toolbar fn__flex fn__space", "padding:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--b3-theme-background-light)");
    const sourceSelect = this._el("select", "b3-select history__source");
    sourceSelect.appendChild(this._option("0", i18n.dataSourceLocal));
    sourceSelect.appendChild(this._option("1", i18n.dataSourceRemote));
    const countEl = this._el("span", "history__count ft__on-surface ft__smaller", "", i18n.totalPrefix + " 0 " + i18n.totalSuffix);
    // 本机上次提交信息（展示用，可为空）
    const localInfo = this._el("span", "history__local ft__on-surface ft__smaller");
    const sha = this._opts.localCommitSha || "";
    localInfo.textContent = i18n.localCommitLabel + ": " + (sha ? sha.slice(0, 8) : "-");
    if (this._opts.localCommitTime) localInfo.title = this._opts.localCommitTime;
    const notebookSelect = this._el("select", "b3-select history__notebook");
    const pathInput = this._el("input", "b3-text-field history__path", "width:160px");
    pathInput.type = "text";
    pathInput.placeholder = i18n.fileSearchPlaceholder;
    const sinceLabel = this._el("span", "ft__on-surface ft__smaller", "", i18n.startTime);
    const sinceInput = this._el("input", "b3-text-field history__since", "width:150px");
    sinceInput.type = "datetime-local";
    const untilLabel = this._el("span", "ft__on-surface ft__smaller", "", i18n.endTime);
    const untilInput = this._el("input", "b3-text-field history__until", "width:150px");
    untilInput.type = "datetime-local";
    const searchBtn = this._el("button", "b3-button b3-button--outline history__search", "", i18n.search);
    searchBtn.type = "button";
    toolbar.append(sourceSelect, countEl, localInfo, notebookSelect, pathInput,
      sinceLabel, sinceInput, untilLabel, untilInput, searchBtn);
    const body = this._el("div", "history__body fn__flex fn__flex-1", "min-height:0");
    const commitsEl = this._el("div", "history__commits b3-list b3-list--background",
      "flex:0 0 320px;width:320px;overflow-y:auto;position:relative;margin:0;border-right:1px solid var(--b3-theme-background-light)");
    const right = this._el("div", "history__right fn__flex fn__flex-column", "flex:1;min-width:0;min-height:0");
    const filesEl = this._el("div", "history__files b3-list",
      "flex:0 0 auto;max-height:40%;overflow-y:auto;min-height:0;position:relative;padding:2px 0;margin:0;border-bottom:1px solid var(--b3-theme-background-light)");
    const diffEl = this._el("div", "history__diff fn__flex", "flex:1;min-height:0;position:relative");
    const leftCol = this._buildDiffCol(i18n.commitVersion, true);
    const rightCol = this._buildDiffCol(i18n.localVersion, false);
    diffEl.append(leftCol.el, rightCol.el);
    right.append(filesEl, diffEl);
    body.append(commitsEl, right);
    root.append(toolbar, body);
    [this._rootEl, this._sourceSelect, this._countEl, this._notebookSelect, this._pathInput] =
      [root, sourceSelect, countEl, notebookSelect, pathInput];
    [this._sinceInput, this._untilInput, this._searchBtn, this._commitsEl, this._filesEl, this._diffEl] =
      [sinceInput, untilInput, searchBtn, commitsEl, filesEl, diffEl];
    [this._leftTitle, this._rightTitle, this._leftTextarea, this._rightTextarea] =
      [leftCol.title, rightCol.title, leftCol.textarea, rightCol.textarea];
    this._opts.container.appendChild(root);
  }
  /** 创建元素：tag + 可选 class + 可选内联样式 + 可选文本 */
  _el(tag, cls, css, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (css) e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  /** 对比列：上方小标题 + 下方只读 textarea */
  _buildDiffCol(titleText, withBorder) {
    const col = this._el("div", "history__col fn__flex fn__flex-column",
      "flex:1;min-width:0;min-height:0" + (withBorder ? ";border-right:1px solid var(--b3-theme-background-light)" : ""));
    const title = this._el("div", "history__col-title",
      "padding:6px 8px;font-size:12px;color:var(--b3-theme-on-surface);border-bottom:1px solid var(--b3-theme-background-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis", titleText);
    const textarea = this._el("textarea", "history__text fn__flex-1",
      "width:100%;min-height:0;resize:none;border:none;outline:none;padding:8px;box-sizing:border-box;font-family:var(--b3-font-family-code,monospace);font-size:12px;line-height:1.5;color:var(--b3-theme-on-background);background:transparent");
    textarea.readOnly = true;
    textarea.spellcheck = false;
    col.append(title, textarea);
    return { el: col, title, textarea };
  }

  // ─────────── 事件绑定 ───────────
  _bindEvents() {
    const signal = this._abort.signal;
    for (const [el, type] of [[this._sourceSelect, "change"], [this._notebookSelect, "change"], [this._searchBtn, "click"]]) {
      el.addEventListener(type, () => this._reloadCommits(), { signal });
    }
    this._pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._reloadCommits();
    }, { signal });
    // 提交列表：点击选中、滚动到底自动翻页（事件委托）
    this._commitsEl.addEventListener("click", (e) => {
      const item = e.target.closest(".history__commit");
      if (item && item.dataset.sha) this._selectCommit(item.dataset.sha);
    }, { signal });
    this._commitsEl.addEventListener("scroll", () => {
      if (this._commitsEl.scrollTop + this._commitsEl.clientHeight >= this._commitsEl.scrollHeight - 24) this._loadCommitsPage();
    }, { signal });
    // 文件列表：点击文件名 / 回滚 / 下载（事件委托）
    this._filesEl.addEventListener("click", (e) => {
      const nameEl = e.target.closest(".history__filename");
      if (nameEl && nameEl.dataset.path) { this._loadDiff(nameEl.dataset.path); return; }
      const rb = e.target.closest(".history__btn--rollback");
      if (rb && rb.dataset.path) { this._runFileAction("rollback", rb.dataset.path); return; }
      const dl = e.target.closest(".history__btn--download");
      if (dl && dl.dataset.path) { this._runFileAction("download", dl.dataset.path); return; }
    }, { signal });
  }

  // ─────────── 提交列表 ───────────
  /** 按当前筛选条件重置列表并从第一页重新加载 */
  async _reloadCommits() {
    if (this._destroyed) return;
    this._commitsSeq += 1;
    this._filesSeq += 1; // 使在途的文件/对比请求失效
    // 本地数据源但本机无提交：提示并退回远端提交
    if (this._dataSource === "0" && !this._opts.localCommitSha) {
      this._dataSource = "1";
      this._sourceSelect.value = "1";
      this._opts.notify(this._i18n.noLocalCommit, "info");
    }
    this._startRef = this._dataSource === "0" ? this._opts.localCommitSha : this._opts.branchName;
    this._commits = [];
    this._page = 0;
    this._hasMore = Boolean(this._startRef);
    this._selectedSha = "";
    this._commitsEl.scrollTop = 0;
    this._countEl.textContent = this._i18n.totalPrefix + " 0 " + this._i18n.totalSuffix;
    this._removePlaceholder(this._commitsEl);
    this._commitsEl.textContent = "";
    this._clearDiff();
    this._renderFiles(null, this._i18n.selectCommitHint);
    if (!this._startRef) { this._setPlaceholder(this._commitsEl, this._i18n.emptyCommits); return; }
    await this._loadCommitsPage();
  }
  /** 加载下一页并追加；返回条数不足 perPage 时停止翻页 */
  async _loadCommitsPage() {
    if (this._destroyed || this._loadingCommits || !this._hasMore) return;
    const seq = this._commitsSeq;
    this._loadingCommits = true;
    const el = this._commitsEl;
    this._showLoading(el);
    try {
      const query = { sha: this._startRef, perPage: SyncHistoryPanel.PER_PAGE, page: this._page };
      const path = this._queryPath();
      if (path) query.path = path;
      const since = this._sinceInput.value ? new Date(this._sinceInput.value).toISOString() : "";
      if (since) query.since = since;
      const until = this._untilInput.value ? new Date(this._untilInput.value).toISOString() : "";
      if (until) query.until = until;
      const list = await this._provider.listCommits(query);
      if (this._destroyed || seq !== this._commitsSeq) return;
      const items = Array.isArray(list) ? list : [];
      this._appendCommits(items);
      this._hasMore = items.length >= SyncHistoryPanel.PER_PAGE;
      this._page += 1;
    } catch (err) {
      if (this._destroyed || seq !== this._commitsSeq) return;
      this._hasMore = false; // 失败后停止自动翻页，避免反复触发
      this._notifyFail(err, this._i18n.loadFailed);
    } finally {
      this._loadingCommits = false;
      if (!this._destroyed) this._hideLoading(el);
    }
  }
  /** 去重追加提交（含 DOM 渲染与计数更新） */
  _appendCommits(list) {
    const seen = new Set(this._commits.map((c) => c.sha));
    const frag = document.createDocumentFragment();
    for (const c of list) {
      if (!c || !c.sha || seen.has(c.sha)) continue;
      seen.add(c.sha);
      this._commits.push(c);
      frag.appendChild(this._createCommitItem(c));
    }
    this._countEl.textContent = this._i18n.totalPrefix + " " + this._commits.length + " " + this._i18n.totalSuffix;
    if (this._commits.length === 0) { this._setPlaceholder(this._commitsEl, this._i18n.emptyCommits); return; }
    this._removePlaceholder(this._commitsEl);
    this._commitsEl.appendChild(frag);
  }
  /** 列表项：第一行提交信息首行，第二行小字灰色=作者+本地时间 */
  _createCommitItem(commit) {
    const item = this._el("div", "b3-list-item history__commit", "cursor:pointer;display:flex;align-items:center");
    item.dataset.sha = commit.sha;
    item.title = commit.message || commit.sha;
    const wrap = this._el("div", "fn__flex fn__flex-column fn__flex-1", "min-width:0");
    const title = this._el("div", "history__commit-title", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      (commit.message || "").split("\n")[0] || commit.sha);
    const date = commit.date ? new Date(commit.date) : null;
    const time = date && !isNaN(date.getTime()) ? date.toLocaleString() : "";
    const meta = this._el("div", "history__commit-meta ft__on-surface ft__smaller", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
      [commit.author, time].filter(Boolean).join(" · "));
    wrap.append(title, meta);
    item.appendChild(wrap);
    if (commit.sha === this._selectedSha) this._setHighlight(item, true);
    return item;
  }
  /** 选中提交：高亮 + 加载文件列表 + 清空对比区 */
  _selectCommit(sha) {
    if (!sha || sha === this._selectedSha) return;
    this._selectedSha = sha;
    for (const item of this._commitsEl.querySelectorAll(".history__commit")) {
      this._setHighlight(item, item.dataset.sha === sha);
    }
    const commit = this._commits.find((c) => c.sha === sha);
    this._clearDiff();
    if (commit) this._loadFiles(commit);
  }
  /** 高亮切换（内联背景兜底：宿主未定义该 class 时也有选中反馈） */
  _setHighlight(item, on) {
    item.classList.toggle("b3-list-item--focus", on);
    item.style.backgroundColor = on ? "var(--b3-theme-primary-light)" : "";
  }

  // ─────────── 文件列表 ───────────
  /** 加载选中提交的变更文件（基准=本机上次提交，无则退化为其父提交） */
  async _loadFiles(commit) {
    if (this._destroyed) return;
    const seq = ++this._filesSeq;
    const el = this._filesEl;
    this._showLoading(el);
    try {
      const base = this._opts.localCommitSha || ((commit.parents && commit.parents[0]) || "");
      const files = await this._provider.compareCommits(base, commit.sha);
      if (this._destroyed || seq !== this._filesSeq) return;
      this._renderFiles(Array.isArray(files) ? files : []);
    } catch (err) {
      if (this._destroyed || seq !== this._filesSeq) return;
      this._renderFiles(null, this._i18n.loadFailed);
      this._notifyFail(err, this._i18n.loadFailed);
    } finally {
      if (!this._destroyed) this._hideLoading(el);
    }
  }
  /** 渲染文件行；files 为空/null 时显示占位提示 */
  _renderFiles(files, hint) {
    this._filesEl.textContent = "";
    this._removePlaceholder(this._filesEl);
    if (!files || !files.length) { this._setPlaceholder(this._filesEl, hint || this._i18n.emptyFiles); return; }
    const frag = document.createDocumentFragment();
    for (const f of files) frag.appendChild(this._createFileRow(f));
    this._filesEl.appendChild(frag);
  }
  /** 文件行：状态徽标 + 可点击文件名 + 行尾操作按钮（removed 无按钮） */
  _createFileRow(file) {
    const i18n = this._i18n;
    const row = this._el("div", "b3-list-item history__file", "display:flex;align-items:center;gap:6px;padding:4px 8px");
    const status = SyncHistoryPanel.STATUS_MAP[file.status] || { key: null, cls: "ft__primary" };
    const badge = this._el("span", "history__status " + status.cls, "min-width:3em",
      status.key ? i18n[status.key] : file.status);
    const name = this._el("span", "history__filename fn__flex-1",
      "cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", file.filename);
    name.dataset.path = file.filename;
    row.append(badge, name);
    if (file.status !== "removed") {
      row.append(
        this._createActionBtn("history__btn--rollback", i18n.rollbackFile, "\u2934\uFE0E", file.filename),
        this._createActionBtn("history__btn--download", i18n.downloadFile, "\u2193", file.filename),
      );
    }
    return row;
  }
  _createActionBtn(cls, title, label, path) {
    const btn = this._el("button", "b3-button b3-button--outline history__btn " + cls,
      "padding:1px 6px;height:22px;min-width:22px;line-height:20px;font-size:14px;flex:0 0 auto", label);
    btn.type = "button";
    btn.dataset.path = path;
    btn.title = title;
    return btn;
  }

  // ─────────── 内容对比 ───────────
  /** 点击文件名：左侧提交版本内容，右侧本地当前内容（失败显示空并轻提示） */
  async _loadDiff(path) {
    if (this._destroyed || !path || !this._selectedSha) return;
    const seq = ++this._filesSeq;
    const i18n = this._i18n;
    const el = this._diffEl;
    this._showLoading(el);
    this._leftTextarea.value = "";
    this._rightTextarea.value = "";
    this._leftTitle.textContent = i18n.commitVersion + " " + this._selectedSha.slice(0, 8);
    this._rightTitle.textContent = i18n.localVersion;
    try {
      // 并行取两侧内容；allSettled 保证一侧失败不影响另一侧
      const [left, right] = await Promise.allSettled([
        this._provider.getFileContent(path, this._selectedSha),
        this._provider.getFileContent(path, this._opts.branchName),
      ]);
      if (this._destroyed || seq !== this._filesSeq) return;
      if (left.status === "fulfilled" && left.value && typeof left.value.text === "string") this._leftTextarea.value = left.value.text;
      else if (left.status === "rejected") this._notifyFail(left.reason, i18n.fileLoadFailed);
      if (right.status === "fulfilled" && right.value && typeof right.value.text === "string") this._rightTextarea.value = right.value.text;
      else if (right.status === "rejected") { this._rightTextarea.value = ""; this._notifyFail(right.reason, i18n.fileLoadFailed); }
    } finally {
      if (!this._destroyed) this._hideLoading(el);
    }
  }
  /** 清空对比区并复位标题 */
  _clearDiff() {
    this._leftTextarea.value = "";
    this._rightTextarea.value = "";
    this._leftTitle.textContent = this._i18n.commitVersion;
    this._rightTitle.textContent = this._i18n.localVersion;
  }

  // ─────────── 回滚 / 下载 ───────────
  /** 通用文件动作：遮罩 + 调用回调 + 结果轻提示 */
  async _runFileAction(kind, path) {
    if (this._destroyed) return;
    const i18n = this._i18n;
    const done = kind === "rollback" ? i18n.rollbackDone : i18n.downloadDone;
    const fail = kind === "rollback" ? i18n.rollbackFailed : i18n.downloadFailed;
    const fn = kind === "rollback" ? this._opts.onRollback : this._opts.onDownload;
    const el = this._filesEl;
    this._showLoading(el);
    try {
      await fn(path, this._selectedSha);
      if (!this._destroyed) this._opts.notify(done, "success");
    } catch (err) {
      if (!this._destroyed) this._notifyFail(err, fail);
    } finally {
      if (!this._destroyed) this._hideLoading(el);
    }
  }

  // ─────────── 查询参数 ───────────
  /** path 筛选：笔记本前缀与文件路径输入合并；输入以 data/ 开头视为完整路径直接使用 */
  _queryPath() {
    const nb = this._notebookSelect.value;
    const input = this._pathInput.value.trim().replace(/^\/+/, "");
    if (input.startsWith("data/")) return input;
    if (nb && input) return nb + "/" + input;
    return nb || input;
  }

  // ─────────── 工具方法 ───────────
  _option(value, text) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  }
  /** 失败轻提示：优先原始错误信息，缺失时用兜底文案 */
  _notifyFail(err, fallback) {
    let msg = "";
    if (err) msg = err.message || String(err);
    this._opts.notify(msg || fallback, "error");
  }
  /** 容器上叠加绝对定位居中 loading 遮罩（按容器计数，支持并发请求） */
  _showLoading(el) {
    if (!el || this._destroyed) return;
    const count = this._loadingCount.get(el) || 0;
    if (count === 0) {
      const overlay = this._el("div", "fn__loading",
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:10;background-color:var(--b3-theme-background);opacity:0.85");
      const img = this._el("img");
      img.width = 64;
      img.src = "/stage/loading-pure.svg";
      img.alt = this._i18n.loadingText;
      overlay.appendChild(img);
      el.appendChild(overlay);
      el.style.position = "relative";
      this._loadingOverlays.set(el, overlay);
    }
    this._loadingCount.set(el, count + 1);
  }
  _hideLoading(el) {
    if (!el) return;
    const count = (this._loadingCount.get(el) || 0) - 1;
    if (count > 0) { this._loadingCount.set(el, count); return; }
    this._loadingCount.delete(el);
    const overlay = this._loadingOverlays.get(el);
    if (overlay) { overlay.remove(); this._loadingOverlays.delete(el); }
  }
  /** 设置空态占位（自动替换已有占位） */
  _setPlaceholder(el, text) {
    this._removePlaceholder(el);
    const p = this._el("div", "history__placeholder", "padding:16px;text-align:center;font-size:13px;color:var(--b3-theme-on-surface)", text);
    el.appendChild(p);
    this._placeholders.set(el, p);
  }
  _removePlaceholder(el) {
    const p = this._placeholders.get(el);
    if (p) { p.remove(); this._placeholders.delete(el); }
  }
}
