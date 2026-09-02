/**
 * SY-GSP 插件入口(同步引擎 2.0)。
 * 职责: 生命周期、依赖装配、菜单/设置/面板挂接、自动同步管理。
 * 不包含 Git API 细节、合并细节与状态机实现(分属 git/sync 层)。
 */

import * as q from "siyuan";
import { createKernel } from "../local/kernel.js";
import { WorkspaceAdapter } from "../local/workspace-adapter.js";
import { ContentAdapter } from "../local/content-adapter.js";
import { GitHubProvider } from "../git/github-provider.js";
import { GiteeProvider } from "../git/gitee-provider.js";
import { SyncPlanner } from "../sync/sync-planner.js";
import { ThreeWayMerger } from "../sync/three-way-merger.js";
import { CommitBuilder } from "../sync/commit-builder.js";
import { ConflictService } from "../sync/conflict-service.js";
import { SyncController, ENGINE_STATE_FILE } from "../sync/sync-controller.js";
import { SyncMetadataStore } from "../storage/sync-metadata-store.js";
import { SyncHistoryStore } from "../storage/sync-history-store.js";
import { LocalManifestStore } from "../storage/local-manifest-store.js";
import { Migration } from "../storage/migration.js";
import { createEventBus } from "../util/event-bus.js";
import { parseRepoAddress } from "./repo-address.js";
import { SettingsPanelBuilder } from "../ui/settings-builder.js";
import { PER_PLATFORM_KEYS, PLATFORM_CONFIG_FILES } from "../ui/settings-panel.js";
import { NotificationService } from "../ui/notification-service.js";
import { ConflictDialog } from "../ui/conflict-dialog.js";
import { DiagnosisPanel } from "../ui/diagnosis-panel.js";
import { RuntimeLogs, openLogsDialog } from "../ui/runtime-logs.js";
import { SyncHistoryPanel } from "../ui/sync-history-panel.js";
import { buildTopBarMenu } from "./menu.js";

const ICONS_MAIN =
  '<symbol id="iconGmailSync" viewBox="0 0 1024 1024"><path d="M998.4 627.2c-51.2 230.4-256 396.8-499.2 396.8-224 0-409.6-140.8-480-339.2h121.6c64 134.4 198.4 230.4 358.4 230.4 179.2 0 332.8-121.6 384-281.6l115.2-6.4zM499.2 0c224 0 409.6 140.8 480 339.2h-121.6c-64-134.4-198.4-230.4-358.4-230.4-179.2 0-332.8 121.6-384 281.6L0 396.8C51.2 172.8 256 0 499.2 0z" fill="#646A73"></path><path d="M998.4 332.8c0 32-25.6 57.6-57.6 64h-140.8c-19.2 0-32-12.8-32-32v-51.2c0-19.2 12.8-32 32-32h83.2V32c0-12.8 12.8-25.6 25.6-32h57.6c19.2 0 32 12.8 32 32v300.8zM0 659.2c0-32 25.6-57.6 57.6-64h140.8c19.2 0 32 12.8 32 32v51.2c0 19.2-12.8 32-32 32H115.2V960c0 12.8-12.8 25.6-25.6 32H32c-19.2 0-32-12.8-32-32v-300.8z" fill="#646A73"></path><path d="M665.6 569.6H512V473.6h249.6c12.8 0 12.8 0 12.8 6.4 6.4 70.4 0 134.4-38.4 192-38.4 57.6-96 96-160 108.8-83.2 19.2-166.4 0-236.8-51.2-57.6-44.8-89.6-102.4-96-172.8-19.2-147.2 64-275.2 204.8-313.6 89.6-19.2 172.8 0 243.2 57.6l6.4 6.4L620.8 384l-6.4-6.4c-25.6-25.6-64-38.4-108.8-38.4-83.2 0-153.6 64-160 147.2-12.8 89.6 44.8 172.8 134.4 192 51.2 12.8 96 6.4 140.8-25.6 19.2-19.2 38.4-44.8 44.8-76.8v-6.4z" fill="#646A73"></path></symbol>';
const ICONS_SYNC =
  '<symbol id="iconModeSync" viewBox="0 0 1024 1024"><path d="M512 128c-212.064 0-384 171.936-384 384h-64l106.624 149.312L277.312 512H213.344c0-164.928 133.728-298.656 298.656-298.656 61.6 0 118.848 18.624 166.4 50.56l46.912-51.904A380.544 380.544 0 0 0 512 128z m331.328 234.688L746.688 512h64c0 164.928-133.728 298.656-298.656 298.656a297.216 297.216 0 0 1-166.4-50.56l-46.912 51.904A380.544 380.544 0 0 0 512 896c212.064 0 384-171.936 384-384h64l-106.624-149.312z" fill="currentColor"></path></symbol>';

export default class SyGspPlugin extends q.Plugin {
  constructor(...args) {
    super(...args);
    this.isMobile = String(q.getFrontend ? q.getFrontend() : "desktop").indexOf("mobile") >= 0;
    this.timerTask = null;
    this.topBarElement = null;
    this.logs = new RuntimeLogs(200);
    this.events = createEventBus();
  }

  async onload() {
    try {
      this.kernel = createKernel(q);
      await this._initStores();
      this.notification = new NotificationService({ q, i18n: this.i18n });
      this.settingsBuilder = new SettingsPanelBuilder({
        plugin: this,
        q,
        i18n: this.i18n,
        metadataStore: this.metadataStore,
        onPlatformChanged: async () => {
          this.logs.info("平台已切换: " + this._platform());
        },
      });
      this.settingUtils = await this.settingsBuilder.build();
      await this._migrateFromLegacyIfNeeded();
      this.conflictDialog = new ConflictDialog({
        q,
        i18n: this.i18n,
        conflictService: this.conflictService,
        onDecide: (decisions) => this.controller.resolveConflicts(decisions),
        notify: (msg, type) => this.notification.toast(msg, type),
      });
      this.conflictDialog.setKernel(this.kernel);
      this.diagnosisPanel = new DiagnosisPanel({
        q,
        i18n: this.i18n,
        runChecks: () => this._runDiagnosis(),
        previewPlan: () => this._previewPlan(),
        onChooseBase: (choice) => this.controller.resolveConflicts({ __base__: choice }),
        onFirstWriteConfirmed: async () => {
          await this._saveEngineState({ firstWriteConfirmed: true });
          this.logs.info("首次写入已确认");
          await this.syncNow({ trigger: "manual" });
        },
        notify: (msg, type) => this.notification.toast(msg, type),
      });
      this.controller = this._buildController();
      await this.controller.restore();
      this.createIcons();
    } catch (err) {
      this.logs.error("onload 失败: " + ((err && err.stack) || err));
      console.error("[SY-GSP] onload 失败:", err);
    }
  }

  async onLayoutReady() {
    try {
      this._registerTopBar();
      this._bindEngineEvents();
      await this._applyStartupBehavior();
    } catch (err) {
      this.logs.error("onLayoutReady 失败: " + ((err && err.stack) || err));
      console.error("[SY-GSP] onLayoutReady 失败:", err);
    }
  }

  async onunload() {
    if (this.timerTask) {
      clearInterval(this.timerTask);
      this.timerTask = null;
    }
    if (this.controller) this.controller.destroy();
  }

  async uninstall() {
    q.showMessage(this.i18n.byePlugin);
  }

  createIcons() {
    this.addIcons(ICONS_MAIN);
    this.addIcons(ICONS_SYNC);
  }

  // ---------- 装配 ----------

  async _initStores() {
    this.metadataStore = new SyncMetadataStore(this);
    await this.metadataStore.load();
    this.historyStore = new SyncHistoryStore(this);
    await this.historyStore.load();
    this.manifestStore = new LocalManifestStore(this);
    await this.manifestStore.load();
    this.conflictService = new ConflictService(this);
    await this.conflictService.load();
  }

  /** 旧版 SGSP 设置迁移(仅首次;失败不影响使用,详见迁移报告) */
  async _migrateFromLegacyIfNeeded() {
    const marker = await this.loadData("migration-report.json");
    if (marker) return;
    const target = {
      setAndSave: async (key, value) => {
        if (PER_PLATFORM_KEYS.includes(key)) {
          const file = PLATFORM_CONFIG_FILES[this._platform()] + ".json";
          const data = (await this.loadData(file)) || {};
          data[key] = value;
          await this.saveData(file, data);
          this.settingsBuilder.utils.set(key, value);
        } else {
          await this.settingsBuilder.utils.setAndSave(key, value);
        }
      },
    };
    const migration = new Migration(this.kernel, target, this.metadataStore);
    const report = await migration.migrate(this._repoInfo()).catch((err) => ({
      migratedKeys: [],
      legacyHint: null,
      errors: [String((err && err.message) || err)],
    }));
    await this.saveData("migration-report.json", report);
    if (report.migratedKeys.length > 0) {
      this.logs.info("旧版设置迁移完成: " + report.migratedKeys.length + " 项");
      const tpl = this.i18n.sygspMigrated || "已迁移旧版 SGSP 设置 {n} 项;同步基准需重新确认";
      q.showMessage(tpl.replace("{n}", String(report.migratedKeys.length)), 6000, "info");
    }
    if (report.errors && report.errors.length > 0) {
      this.logs.error("旧版迁移错误: " + report.errors.join("; "));
    }
  }

  _platform() {
    return this.settingUtils && Number(this.settingUtils.take("upload_sub_platform")) === 1 ? "gitee" : "github";
  }

  _repoInfo() {
    if (!this.settingUtils) {
      return { provider: "github", owner: "", repo: "", branch: "", token: "" };
    }
    const addr = String(this.settingUtils.take("repository_address") || "");
    const parsed = parseRepoAddress(addr);
    return {
      provider: this._platform(),
      owner: parsed.owner,
      repo: parsed.repo,
      branch: String(this.settingUtils.take("repository_branch") || "").trim(),
      token: String(this.settingUtils.take("submit_token") || ""),
    };
  }

  _repoKey(info) {
    return info.provider + ":" + info.owner + "/" + info.repo + ":" + info.branch;
  }

  _buildController() {
    const self = this;
    return new SyncController({
      plugin: this,
      settings: this.settingUtils,
      events: this.events,
      notify: (msg, type) => this.notification.toast(msg, type),
      i18n: (key, fallback) => (this.i18n && this.i18n[key]) || fallback,
      repoInfo: () => this._repoInfo(),
      autoSync: {
        pause: () => this._stopAutoSyncTimer(),
        resume: () => this._restartAutoSyncIfConfigured(),
      },
      makeEngineDeps: (ctx) => self._makeEngineDeps(ctx),
    });
  }

  _makeEngineDeps(ctx) {
    const info = this._repoInfo();
    const self = this;
    const provider =
      info.provider === "gitee"
        ? new GiteeProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token })
        : new GitHubProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token });
    const workspace = new WorkspaceAdapter(this.kernel, {
      getUserIgnore: () => this.settingUtils.take("ignore_file") || "",
      getSyncRange: () => Number(this.settingUtils.take("sync_range")) || 0,
      getNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return (res && res.notebooks) || [];
      },
    });
    const contentAdapter = new ContentAdapter(this.kernel, { backupDir: "temp/SY-GSP/backup/", i18n: this.i18n });
    const planner = new SyncPlanner({
      readLocal: async (path) => {
        const blob = await this.kernel.getFile(path);
        return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
      },
      readRemoteBlobBySha: async (sha) => provider.getBlob(sha),
      guardLocalDelete: async (path) =>
        workspace.guardLocalDelete(path, self.manifestStore, { remoteEntryExists: true }),
    });
    return {
      provider,
      workspace,
      contentAdapter,
      metadataStore: this.metadataStore,
      manifestStore: this.manifestStore,
      conflictService: this.conflictService,
      planner,
      merger: new ThreeWayMerger(),
      commitBuilder: new CommitBuilder({
        requestLimit: Number(this.settingUtils.take("sygsp_blob_request_limit")) || 33554432,
      }),
      events: this.events,
      config: {
        get repoKey() {
          return self._repoKey(info);
        },
        get syncRange() {
          return Number(self.settingUtils.take("sync_range")) || 0;
        },
        get syncFileType() {
          return Number(self.settingUtils.take("sync_file_type")) === 1 ? "markdown" : "raw";
        },
      },
    };
  }

  _saveEngineState(patch) {
    const current = this._engineState || {};
    this._engineState = Object.assign({}, current, patch);
    return this.saveData(ENGINE_STATE_FILE, this._engineState).catch((err) => {
      this.logs.error("状态保存失败: " + String((err && err.message) || err));
    });
  }

  // ---------- 引擎事件 → 日志/通知/历史/面板 ----------

  _bindEngineEvents() {
    this.events.on("state:changed", ({ state, conflictPaused }) => {
      this.logs.info("状态: " + state + (conflictPaused ? " (冲突暂停: " + conflictPaused.kind + ")" : ""));
      if (this.notification) {
        if (this.controller && this.controller.isConflictPaused()) this.notification._badge("conflict");
      }
    });
    this.events.on("sync:success", ({ ctx, result }) => {
      this.logs.info(
        "同步成功 " + result.operationId + " ↑" + result.uploads + " ↓" + result.downloads +
        " 删远" + result.deletionsRemote + " 删本" + result.deletionsLocal
      );
      this._recordHistory(ctx, "SUCCESS", null, result);
      this.notification.syncSuccess(result, {
        automatic: ctx.trigger === "automatic",
        successNotify: this.settingUtils.get("sygsp_success_notify") !== false,
      });
    });
    this.events.on("sync:error", ({ ctx, error }) => {
      this.logs.error("同步失败[" + error.category + "] " + error.toDisplayText());
      this._recordHistory(ctx, "FAILED", error, null);
      this.notification.syncError(error, { automatic: ctx.trigger === "automatic" });
    });
    this.events.on("sync:conflict", ({ ctx, conflictPaused }) => {
      this.logs.error("同步暂停[" + conflictPaused.kind + "] " + conflictPaused.reason);
      this._recordHistory(ctx, "CONFLICT_PAUSED", null, { paused: true, kind: conflictPaused.kind });
      this.notification.conflictPaused({
        kind: conflictPaused.kind,
        conflictCount: conflictPaused.conflictCount,
        reason: conflictPaused.reason,
      });
      if (conflictPaused.kind === "FILE_CONFLICTS") {
        const set = this.conflictService.openSet(this._repoKey(this._repoInfo()));
        if (set) this.conflictDialog.show(set);
      } else {
        this.diagnosisPanel.show({ mode: "base_recovery" });
      }
    });
    this.events.on("conflict:reopen", () => {
      const set = this.conflictService.openSet(this._repoKey(this._repoInfo()));
      if (set) this.conflictDialog.show(set);
      else this.diagnosisPanel.show({ mode: "base_recovery" });
    });
  }

  // ---------- 同步入口 ----------

  async syncNow({ trigger = "manual", mode = "auto" } = {}) {
    const info = this._repoInfo();
    if (!info.owner || !info.repo || !info.branch || !info.token) {
      this.notification.toast(this.i18n.warnFinishSettingConfig || "请先完整填写设置", "error");
      this.openSetting();
      return { skipped: true };
    }
    const state = this._engineState || (await this.loadData(ENGINE_STATE_FILE)) || {};
    this._engineState = state;
    if (!state.firstWriteConfirmed && mode === "auto" && trigger !== "conflict_resolution") {
      // 2.0 灰度: 首次写入前必须经过只读诊断与计划预览确认
      this.diagnosisPanel.show({ mode: "first_sync" });
      return { skipped: true, firstRun: true };
    }
    const strategy = Number(this.settingUtils.take("sync_strategy")) || 0;
    if (mode === "auto" && strategy === 1) {
      this._openDirectionDialog();
      return { skipped: true, chooseDirection: true };
    }
    if (mode === "auto" && strategy === 2) mode = "remote_over_local";
    if (mode === "auto" && strategy === 3) mode = "local_over_remote";
    this.controller.retryPolicy.enabled = this.settingUtils.get("sygsp_auto_retry") === true;
    this.notification.syncStarted(trigger);
    return this.controller.syncNow({ trigger, mode });
  }

  /** 选择同步方向弹窗(策略 1) */
  _openDirectionDialog() {
    const t = this.i18n;
    let direction = "0";
    const dialog = new q.Dialog({
      title: t.sygspChooseDirectionTitle || "选择同步方向",
      content: '<div id="sygspDirection" style="padding:16px;"></div>',
      width: "520px",
    });
    const root = dialog.element.querySelector("#sygspDirection");

    const mkLabel = (value, text) => {
      const label = document.createElement("label");
      label.className = "fn__flex b3-label";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "upload";
      input.value = value;
      input.addEventListener("change", () => {
        direction = value;
      });
      const textEl = document.createElement("div");
      textEl.textContent = text;
      label.appendChild(input);
      label.appendChild(textEl);
      return label;
    };
    root.appendChild(mkLabel("0", t.sygspDirRemote || "⬇️ 下载云端数据覆盖本地"));
    root.appendChild(mkLabel("1", t.sygspDirLocal || "⬆️ 上传本地数据覆盖云端"));

    const bar = document.createElement("div");
    bar.className = "fn__flex";
    bar.style.justifyContent = "flex-end";
    bar.style.gap = "8px";
    const cancel = document.createElement("button");
    cancel.className = "b3-button b3-button--cancel";
    cancel.textContent = t.cancel || "取消";
    cancel.addEventListener("click", () => dialog.destroy());
    const confirm = document.createElement("button");
    confirm.className = "b3-button b3-button--text";
    confirm.textContent = t.sygspConfirm || "确定";
    confirm.addEventListener("click", () => {
      dialog.destroy();
      const mode = direction === "0" ? "remote_over_local" : "local_over_remote";
      if (this._hasUnresolvedBase()) {
        this.diagnosisPanel.show({ mode: "base_recovery" });
        return;
      }
      this.controller.retryPolicy.enabled = this.settingUtils.get("sygsp_auto_retry") === true;
      this.notification.syncStarted("manual");
      this.controller.syncNow({ trigger: "manual", mode });
    });
    bar.appendChild(cancel);
    bar.appendChild(confirm);
    root.appendChild(bar);
  }

  _hasUnresolvedBase() {
    return !this.metadataStore.getBaseCommit(this._repoKey(this._repoInfo()));
  }

  // ---------- 自动同步 ----------

  _restartAutoSyncIfConfigured() {
    this._stopAutoSyncTimer();
    if (!this.settingUtils) return;
    if (Number(this.settingUtils.take("sync_mode")) !== 0) return;
    if (this.settingUtils.take("enabled_sync") === false) return;
    this.startAutoSyncTimer(Number(this.settingUtils.take("sync_interval")) || 600000);
  }

  _stopAutoSyncTimer() {
    if (this.timerTask) {
      clearInterval(this.timerTask);
      this.timerTask = null;
      this.logs.info("自动同步已暂停");
    }
  }

  startAutoSyncTimer(intervalMs) {
    this._stopAutoSyncTimer();
    this.timerTask = setInterval(() => {
      if (this.controller.isConflictPaused()) return; // 暂停期间自动触发被跳过
      this.controller.markAutoTick();
      this.syncNow({ trigger: "automatic" }).catch((err) => {
        this.logs.error("自动同步异常: " + String((err && err.message) || err));
      });
    }, intervalMs);
    this.logs.info("自动同步已启动,间隔 " + Math.round(intervalMs / 1000) + "s");
  }

  async _applyStartupBehavior() {
    const mode = Number(this.settingUtils.take("sync_mode")) || 0;
    const enabled = this.settingUtils.take("enabled_sync") !== false;
    if (this.controller.isConflictPaused()) {
      this.notification.conflictPaused({
        kind: this.controller.conflictPaused.kind,
        conflictCount: this.controller.conflictPaused.conflictCount,
      });
    }
    if (!enabled) return;
    if (mode === 0) {
      this._restartAutoSyncIfConfigured();
    } else if (mode === 1) {
      this.syncNow({ trigger: "startup" }).catch((err) => this.logs.error("启动同步失败: " + String((err && err.message) || err)));
    }
  }

  // ---------- UI 动作 ----------

  _registerTopBar() {
    if (this.isMobile) {
      this.topBarElement = document.querySelector("#toolbarMore");
    } else if (typeof q.addTopBar === "function") {
      q.addTopBar({
        icon: "iconGmailSync",
        title: this.i18n.addTopBarIcon || "SY-GSP",
        position: "right",
        callback: (event) => this._openMenu(event),
      });
      this.topBarElement = document.querySelector('button[data-id="iconGmailSync"]');
    }
    if (this.notification) this.notification.setTopBarElement(this.topBarElement);
  }

  _openMenu(event) {
    const actions = {
      startSync: () => this.syncNow({ trigger: "manual" }),
      refreshWorkspaceTree: () => this.kernel.refreshFiletree(),
      recoverAssets: () => this._recoverAssets(),
      openHistory: () => this.openSyncHistoryPanel(),
      openLogs: () => openLogsDialog({ q, i18n: this.i18n, logs: this.logs }),
      openDiagnosis: () => this.diagnosisPanel.show({ mode: "diagnosis" }),
      openSettings: () => this.openSetting(),
      resolveConflict: () => {
        const set = this.conflictService.openSet(this._repoKey(this._repoInfo()));
        if (set) this.conflictDialog.show(set);
        else this.diagnosisPanel.show({ mode: this.controller.conflictPaused && this.controller.conflictPaused.kind === "BASE_UNRESOLVED" ? "base_recovery" : "diagnosis" });
      },
      getSetting: (key) => this.settingUtils.take(key),
      setSettingAndSave: (key, value) => this.settingUtils.setAndSave(key, value),
    };
    const menu = buildTopBarMenu({
      q,
      plugin: this,
      i18n: this.i18n,
      actions,
      conflictPaused: this.controller.isConflictPaused(),
    });
    const anchor = event && event.target ? event.target : this.topBarElement;
    if (anchor && anchor.getBoundingClientRect) {
      const rect = anchor.getBoundingClientRect();
      menu.open({ x: rect.right, y: rect.bottom });
    } else {
      menu.open({ x: window.innerWidth - 220, y: 32 });
    }
  }

  openSetting() {
    // SettingUtils 约定把 q.Setting 实例挂到 plugin.setting
    const setting = this.setting;
    if (setting && typeof setting.open === "function") setting.open();
  }

  openSyncHistoryPanel() {
    const info = this._repoInfo();
    if (!info.owner || !info.repo || !info.branch || !info.token) {
      this.notification.toast(this.i18n.warnFinishSettingConfig || "请先完整填写设置", "error");
      return;
    }
    const dialog = new q.Dialog({
      positionId: "mainSyncHistory",
      content: '<div id="sygspSyncHistory" class="fn__flex-column" style="height: 100%;"></div>',
      width: "90vw",
      height: "80vh",
      hideCloseIcon: false,
      destroyCallback: () => {
        if (this._historyPanel) {
          this._historyPanel.destroy();
          this._historyPanel = null;
        }
      },
    });
    const provider = this._makeProvider(info);
    const base = this.metadataStore.get(this._repoKey(info));
    this._historyPanel = new SyncHistoryPanel({
      container: dialog.element.querySelector("#sygspSyncHistory"),
      provider: {
        listCommits: (query) => provider.listCommits(query),
        compareCommits: (baseRef, headRef) => provider.compareCommits(baseRef, headRef),
        getFileContent: (path, ref) => provider.getFileContent(path, ref),
      },
      listNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return (res && res.notebooks) || [];
      },
      branchName: info.branch,
      localCommitSha: base && base.lastConfirmedCommit ? base.lastConfirmedCommit : "",
      localCommitTime: base && base.lastSuccessfulAt ? base.lastSuccessfulAt : "",
      i18n: this.i18n,
      onRollback: (path, ref) => this._writeCommitFile(path, ref, provider, true),
      onDownload: (path, ref) => this._writeCommitFile(path, ref, provider, false),
      notify: (msg, type) => this.notification.toast(msg, type),
    });
  }

  _makeProvider(info) {
    return info.provider === "gitee"
      ? new GiteeProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token })
      : new GitHubProvider({ owner: info.owner, repo: info.repo, branch: info.branch, token: info.token });
  }

  /** 历史面板: 回滚(覆盖本地)/下载(另存到隔离目录) */
  async _writeCommitFile(path, ref, provider, overwrite) {
    try {
      const content = await provider.getFileContent(path, ref);
      const bytes = content.bytes;
      if (!bytes || bytes.length === 0) {
        this.notification.toast(this.i18n.sygspFileContentEmpty || "文件内容为空,已停止", "error");
        return;
      }
      const targetPath = overwrite ? path : "temp/SY-GSP/downloads/" + String(path).replace(/^\/+/, "");
      await this.kernel.putFile(targetPath, new Blob([bytes]), false);
      const tpl = overwrite ? this.i18n.sygspRollbackDone || "已回滚" : this.i18n.sygspDownloadDone || "已下载";
      this.notification.toast(tpl + ": " + targetPath, "info");
    } catch (err) {
      this.notification.toast("❌ " + String((err && err.message) || err), "error");
    }
  }

  /** 更新资源路径(菜单) */
  async _recoverAssets() {
    try {
      const adapter = new ContentAdapter(this.kernel, { backupDir: "temp/SY-GSP/backup/" });
      const result = await adapter.replaceAssetPrefix({ path: "", assetsPrefix: this.settingUtils.take("asset_prefix") || "" });
      q.showMessage((this.i18n.updateLocalAssetsPathSucc || "资源路径已更新") + " (" + result.updated + ")", 3000, "info");
    } catch (err) {
      q.showMessage((this.i18n.updateLocalAssetsPathFailed || "资源路径更新失败") + ": " + String((err && err.message) || err), 6000, "error");
    }
  }

  // ---------- 诊断 ----------

  async _runDiagnosis() {
    const checks = [];
    const info = this._repoInfo();
    checks.push({
      name: "仓库配置",
      ok: !!(info.owner && info.repo && info.branch),
      detail: info.owner ? info.provider + ": " + info.owner + "/" + info.repo + " @ " + info.branch : "仓库地址无法解析,请检查设置",
    });
    checks.push({ name: "Token", ok: !!info.token, detail: info.token ? "已配置" : "未配置" });

    try {
      const probePath = "temp/SY-GSP/probe.txt";
      await this.kernel.putFile(probePath, new Blob(["ok"]), false);
      const blob = await this.kernel.getFile(probePath);
      const ok = !!blob && (await blob.text()) === "ok";
      await this.kernel.removeFile(probePath);
      checks.push({ name: "本地文件读写", ok, detail: ok ? "temp/SY-GSP/ 读写正常" : "内容校验失败" });
    } catch (err) {
      checks.push({ name: "本地文件读写", ok: false, detail: String((err && err.message) || err) });
    }

    if (info.owner && info.branch) {
      try {
        const provider = this._makeProvider(info);
        const head = await provider.getBranchHead();
        checks.push({ name: "远端可达", ok: true, detail: "HEAD " + head.sha.slice(0, 8) });
        const repoKey = this._repoKey(info);
        const base = this.metadataStore.getBaseCommit(repoKey);
        const hint = this.metadataStore.getLegacyHint(repoKey);
        checks.push({
          name: "同步基准",
          ok: !!base,
          detail: base
            ? "已确认基准 " + base.slice(0, 8)
            : hint
              ? "旧版基准线索 " + String(hint.sha).slice(0, 8) + "(未验证,需通过首同步向导确认)"
              : "无确认基准(首次同步将进入向导)",
        });
      } catch (err) {
        checks.push({ name: "远端可达", ok: false, detail: String((err && err.message) || err) });
      }
    }

    const migrationReport = await this.loadData("migration-report.json");
    if (migrationReport) {
      const errs = migrationReport.errors || [];
      checks.push({
        name: "旧版设置迁移",
        ok: errs.length === 0,
        detail: "迁移 " + (migrationReport.migratedKeys || []).length + " 项" + (errs.length ? ";错误: " + errs.join("; ") : ""),
      });
    }
    return checks;
  }

  /** 首次写入预览: 只读统计,不执行任何写入 */
  async _previewPlan() {
    const info = this._repoInfo();
    const rows = [];
    if (!info.owner || !info.branch) {
      return [{ name: "同步计划", detail: "配置不完整,无法预览" }];
    }
    const workspace = new WorkspaceAdapter(this.kernel, {
      getUserIgnore: () => this.settingUtils.take("ignore_file") || "",
      getSyncRange: () => Number(this.settingUtils.take("sync_range")) || 0,
      getNotebooks: async () => {
        const res = await this.kernel.lsNotebooks();
        return (res && res.notebooks) || [];
      },
    });
    const scan = await workspace.scan({ range: Number(this.settingUtils.take("sync_range")) || 0 });
    rows.push({
      name: "本地扫描(同步范围内)",
      detail: scan.files.length + " 个文件" + (scan.enumErrorOccurred ? "(存在目录枚举异常)" : ""),
    });
    try {
      const provider = this._makeProvider(info);
      const head = await provider.getBranchHead();
      const commit = await provider.getCommit(head.sha);
      const tree = await provider.getTree(commit.treeSha);
      const remotePaths = new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
      rows.push({ name: "远端文件", detail: remotePaths.size + " 个文件,HEAD " + head.sha.slice(0, 8) });
      const localSet = new Set(scan.files.map((f) => f.path));
      let onlyLocal = 0;
      for (const p of localSet) if (!remotePaths.has(p)) onlyLocal += 1;
      let onlyRemote = 0;
      for (const p of remotePaths) if (!localSet.has(p)) onlyRemote += 1;
      rows.push({ name: "路径差异(粗略)", detail: "仅本地 " + onlyLocal + " / 仅远端 " + onlyRemote + "(内容级判定在首次同步时执行)" });
    } catch (err) {
      rows.push({ name: "远端读取", detail: "失败: " + String((err && err.message) || err) });
    }
    rows.push({ name: "首次写入模式", detail: "将进入首同步向导: 明确以本地或远端为准后执行一次覆盖同步" });
    return rows;
  }

  // ---------- 历史 ----------

  async _recordHistory(ctx, state, error, result) {
    const info = this._repoInfo();
    try {
      await this.historyStore.append(this._repoKey(info), {
        operationId: ctx.id,
        trigger: ctx.trigger,
        startedAt: ctx.startedAt,
        finishedAt: new Date().toISOString(),
        state,
        phase: ctx.phase,
        baseCommit: ctx.baseCommit,
        expectedRemoteHead: ctx.expectedRemoteHead,
        result: result
          ? {
              uploads: result.uploads,
              downloads: result.downloads,
              deletionsRemote: result.deletionsRemote,
              deletionsLocal: result.deletionsLocal,
              commitSha: result.commitSha,
            }
          : null,
        error: error ? error.toSerializable() : null,
        conflictCount: (ctx.conflicts || []).length,
      });
    } catch (err) {
      this.logs.error("历史记录保存失败: " + String((err && err.message) || err));
    }
  }
}
