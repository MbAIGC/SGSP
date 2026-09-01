/**
 * ============================================================================
 * GIT 同步插件 —— 同步状态机 / 冲突处理闭环 / 状态通知 运行时
 * ============================================================================
 *
 * 本模块是本次重构的「单一事实来源」:
 *  - 被 patch/apply-patch.mjs 内联(export 关键字剥离后)注入原生 bundle,
 *    从而在不改动原有同步算法的情况下,给插件加上:
 *        发现冲突 → 🔴冲突状态 → 暂停自动同步 → 通知用户
 *        → 用户选择(保留本地/保留远端/打开冲突文档/稍后处理)
 *        → 解决冲突 → 🟢恢复自动同步
 *  - 被 tests/sync-flow.test.mjs 直接引用,使用假插件实例进行单元测试。
 *
 * 语法约束(与原生 bundle 保持一致,避免注入后被解析失败):
 *  - 不使用可选链(?.)
 *  - 不使用模板字符串(用 + 拼接)
 *  - 不使用 ??(对应场景用 || 或显式判断)
 *  - 不依赖浏览器 API(除宿主注入的 q / plugin)
 *
 * 状态机:
 *
 *   IDLE ──sync()──▶ RUNNING ──成功──▶ SUCCESS ──(自动同步下一轮)──▶ RUNNING
 *                      │
 *                      ├── 失败(非冲突)──▶ FAILED ──(下一轮自动重试 / 用户手动)──▶ RUNNING
 *                      └── 冲突(cause 链含 code===300)──▶ CONFLICT
 *                                                              │
 *                                                           暂停自动同步(timerTask.removeSelf)
 *                                                              ▼
 *                                                        CONFLICT_PAUSED  ◀──持久化,重启后仍保持
 *                                                              │
 *                                         ┌────────────────────┼─────────────────────┐
 *                                         ▼                    ▼                     ▼
 *                                    保留本地版本          保留远端版本            稍后处理/打开冲突文档
 *                                    (强制 本地覆盖远端)  (强制 远端覆盖本地)      (维持暂停)
 *                                         │                    │
 *                                         └────────┬───────────┘
 *                                                  ▼
 *                                             RESOLVING ──成功──▶ RESOLVED
 *                                                                   │
 *                                                         恢复自动同步(startAutoSync)
 *                                                                   ▼
 *                                                                SUCCESS / IDLE
 *
 * 通知:
 *  - 冲突发生: 顶栏图标 🔴 红色闪烁 + 持久化弹窗 + 一次性 toast(避免自动同步反复轰炸)
 *  - 冲突未解决时自动同步被跳过: 每个暂停会话只提示一次
 *  - 冲突解决后: toast 告知并自动恢复自动同步
 *  - 失败(网络/Token/仓库未初始化等): 保持原有 toast 行为不变
 * ============================================================================
 */

"use strict";

/** 同步状态枚举 */
export const SyncState = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed",
  CONFLICT: "conflict",
  CONFLICT_PAUSED: "conflict_paused",
  RESOLVING: "resolving",
  RESOLVED: "resolved",
});

/**
 * 插件设置键(与原生 bundle 中的常量对应,这里用字符串值,
 * 避免注入代码依赖被压缩过的变量名)
 */
export const SETTING = Object.freeze({
  syncMode: "sync_mode", // Ne: 0=自动 1=手动 2=完全手动
  syncInterval: "sync_interval", // je: 自动同步间隔(毫秒)
  syncStrategy: "sync_strategy", // lt: 0=自动 1=选择方向 2=远端覆盖本地 3=本地覆盖远端
  enabledSync: "enabled_sync", // Me
});

/** sync_strategy 取值 */
export const STRATEGY = Object.freeze({
  AUTO: 0,
  CHOOSE: 1,
  REMOTE_OVER_LOCAL: 2,
  LOCAL_OVER_REMOTE: 3,
});

/** sync_mode 取值 */
export const SYNC_MODE = Object.freeze({
  AUTO: 0,
  MANUAL: 1,
  FULL_MANUAL: 2,
});

/** 冲突错误码(dr.CONFLICT = 300) */
export const CONFLICT_CODE = 300;

/** 持久化文件名(存放冲突暂停状态,重启后仍保持暂停) */
export const DATA_FILE = "git-sync-flow.json";

/** 从错误链(cause 链)中查找是否包含冲突错误(Mr 的 code===300) */
export function isConflictError(err, depth) {
  let node = err;
  for (let i = 0; node && i < (depth || 7); i++) {
    if (node.code === CONFLICT_CODE) {
      return true;
    }
    node = node.cause;
  }
  return false;
}

/** 从错误链中提取冲突信息(路径/消息) */
export function extractConflictInfo(err) {
  let node = err;
  for (let i = 0; node && i < 7; i++) {
    if (node.code === CONFLICT_CODE) {
      return {
        path: node.path || "",
        message: node.message || "",
        name: node.name || "CONFLICT",
      };
    }
    node = node.cause;
  }
  return {
    path: "",
    message: String((err && err.message) || err),
    name: "",
  };
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getErrorSummary(err) {
  let node = err;
  let first = null;
  for (let i = 0; node && i < 7; i++) {
    if (!first) first = node;
    if (node.status || (node.response && node.response.status)) {
      const response = node.response || {};
      const data = response.data || {};
      return {
        message: String(data.message || node.message || first.message || node),
        status: response.status || node.status || 0,
        path: node.path || first.path || "",
      };
    }
    node = node.cause;
  }
  return {
    message: String((first && first.message) || err || "未知错误"),
    status: 0,
    path: (first && first.path) || "",
  };
}

function formatErrorSummary(err) {
  const summary = getErrorSummary(err);
  let message = summary.message.replace(/Bearer\\s+[^\\s]+/gi, "Bearer [已隐藏]");
  message = message.replace(/(token|password|authorization|cookie)\\s*[:=]\\s*[^,;\\s]+/gi, "$1=[已隐藏]");
  if (summary.status) message = "HTTP " + summary.status + ": " + message;
  if (summary.path) message += " (文件: " + summary.path + ")";
  return message.slice(0, 500);
}

/**
 * 创建冲突处理宿主(每个插件实例一个)。
 * @param {object} plugin 插件实例(q.Plugin 子类)
 * @param {object} q      siyuan SDK
 */
export function createSyncFlowHost(plugin, q) {
  const host = {
    plugin: plugin,
    q: q,
    state: SyncState.IDLE,
    conflictDetail: null,
    pausedSince: 0,
    // 自动同步定时器打上的一次性标记: 区分「定时器触发」与「用户手动点击」
    autoTick: false,
    autoSkipNotified: false,
    // 本次暂停是否由自动同步定时器引起(决定恢复时是否需要重启定时器)
    pausedTimer: false,
    // 当前是否处于「冲突中 → 用户选择解决方案」的流程
    wasConflictFlow: false,
    // 当前冲突弹窗
    dialog: null,
    restorePromise: null,
    logEntries: [],
  };

  function i18n(key, fallback) {
    try {
      const v = plugin && plugin.i18n ? plugin.i18n[key] : undefined;
      return v === undefined || v === null || v === "" ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function addLog(level, message) {
    const entry = {
      time: new Date().toISOString(),
      level: level || "info",
      message: String(message == null ? "" : message),
    };
    host.logEntries.push(entry);
    if (host.logEntries.length > 200) host.logEntries.shift();
    return entry;
  }

  function notify(msg, type) {
    addLog(type === "error" ? "error" : "info", msg);
    try {
      q.showMessage(msg, 3000, type || "info");
    } catch (e) {
      /* 通知失败不影响主流程 */
    }
  }

  function showRuntimeLogs() {
    const rows = host.logEntries.length
      ? host.logEntries
          .map(function (entry) {
            return "<div><strong>[" + escapeHtml(entry.level.toUpperCase()) + "] " + escapeHtml(entry.time) + "</strong> " + escapeHtml(entry.message) + "</div>";
          })
          .join("")
      : "<div>暂无运行日志</div>";
    try {
      new q.Dialog({
        title: i18n("gSyncRuntimeLogsTitle", "SGSP 运行日志"),
        content: '<div class="fn__flex-column" style="height:100%;overflow:auto;padding:8px;font-family:monospace;white-space:pre-wrap;">' + rows + "</div>",
        width: "80vw",
        height: "70vh",
      });
    } catch (err) {
      addLog("error", "打开运行日志失败: " + (err && err.message ? err.message : err));
      try { q.showMessage("❌ 无法打开 SGSP 运行日志", 3000, "error"); } catch (e) {}
    }
  }

  function setBadge() {
    const el = plugin.topBarElement;
    if (!el || !el.classList) return;
    try {
      if (host.state === SyncState.CONFLICT_PAUSED) {
        el.classList.add("git-sync-conflict-paused");
        el.title = i18n(
          "gSyncPausedTooltip",
          "【SGSP】冲突未解决,自动同步已暂停,请点击处理"
        );
      } else {
        el.classList.remove("git-sync-conflict-paused");
        const base = i18n("addTopBarIcon", "SGSP");
        if (base) el.title = base;
      }
    } catch (e) {
      /* badge 失败不影响主流程 */
    }
  }

  function persist() {
    try {
      if (host.state === SyncState.CONFLICT_PAUSED) {
        plugin.saveData(DATA_FILE, {
          state: host.state,
          conflictDetail: host.conflictDetail || null,
          pausedSince: host.pausedSince,
          pausedTimer: host.pausedTimer,
        }).catch(function () {});
      } else {
        plugin.saveData(DATA_FILE, { state: SyncState.IDLE }).catch(function () {});
      }
    } catch (e) {
      /* 持久化失败不影响主流程(冲突暂停会自动重新建立) */
    }
  }

  /** onload 时调用: 恢复上次未解决的冲突暂停状态 */
  function onAfterLoad() {
    try {
      host.restorePromise = Promise.resolve(plugin.loadData(DATA_FILE));
    } catch (e) {
      host.restorePromise = Promise.reject(e);
    }
    return host.restorePromise
      .then(function (data) {
        if (data && data.state === SyncState.CONFLICT_PAUSED) {
          host.state = SyncState.CONFLICT_PAUSED;
          host.conflictDetail = data.conflictDetail || null;
          host.pausedSince = data.pausedSince || Date.now();
          // 旧状态文件没有 pausedTimer 时，按自动模式兼容恢复定时器。
          host.pausedTimer = data.pausedTimer !== false;
          host.autoSkipNotified = false;
          setBadge();
          setIntervalSafe(function () {
            notify(
              i18n(
                "gSyncRestoredPausedMsg",
                "检测到未解决的同步冲突,自动同步已暂停。请点击插件图标处理冲突"
              ),
              "error"
            );
          }, 0);
        }
        return data;
      })
      .catch(function (err) {
        console.error("git-sync: restore conflict state", err);
        return null;
      });
  }

  /** onLayoutReady 时调用: 根据当前状态刷新顶栏徽标 */
  function attachBadge() {
    setBadge();
  }

  function markAutoTick() {
    host.autoTick = true;
  }

  function consumeAutoTick() {
    const v = host.autoTick;
    host.autoTick = false;
    return v;
  }

  function isPausedConflict() {
    return host.state === SyncState.CONFLICT_PAUSED;
  }

  /** 暂停自动同步定时器 */
  function pauseAutoSync() {
    try {
      if (plugin.timerTask) {
        host.pausedTimer = true;
        plugin.timerTask.removeSelf();
      }
    } catch (e) {
      console.error("git-sync: pauseAutoSync", e);
    }
  }

  /** 恢复自动同步定时器(仅自动同步模式下才重启) */
  function resumeAutoSync() {
    try {
      if (!host.pausedTimer) return;
      const mode = String(plugin.settingUtils.get(SETTING.syncMode));
      if (mode !== String(SYNC_MODE.AUTO)) {
        return; // 用户已切到手动模式,不恢复定时器
      }
      host.pausedTimer = false;
      plugin.startAutoSync(function () {
        plugin.syncDataToCloud();
      });
    } catch (e) {
      console.error("git-sync: resumeAutoSync", e);
    }
  }

  function closeDialog() {
    try {
      if (host.dialog) {
        host.dialog.destroy();
      }
    } catch (e) {
      /* ignore */
    }
    host.dialog = null;
  }

  /** 尽力打开冲突文档: 用内核搜索接口按 _conflict_ 前缀找文档,再尝试用 SDK openTab 打开 */
  function openConflictDoc() {
    const conflict = host.conflictDetail || {};
    const baseName = (conflict.path || "").split("/").pop() || "";
    const key = (baseName.split(".")[0] || "conflict") + "_conflict";
    try {
      if (q && typeof q.fetchSyncPost === "function") {
        q.fetchSyncPost("/api/search/searchDocs", {
          k: key,
          method: 0,
        })
          .then(function (resp) {
            const docs = (resp && resp.data && resp.data.documents) || [];
            const doc = docs.find(function (d) {
              return d && d.name && d.name.indexOf("_conflict_") >= 0;
            });
            if (doc && doc.id && q && typeof q.openTab === "function") {
              q.openTab({
                app: "filetree",
                id: doc.id,
                action: "open-doc-by-id",
                data: { id: doc.id },
              });
              closeDialog();
              return;
            }
            notify(
              i18n(
                "gSyncOpenDocHint",
                "未能在搜索中定位冲突文档,请到左侧文件树中找到文件名含 _conflict_ 的文档打开查看"
              ),
              "info"
            );
          })
          .catch(function () {
            notify(
              i18n(
                "gSyncOpenDocHint",
                "未能在搜索中定位冲突文档,请到左侧文件树中找到文件名含 _conflict_ 的文档打开查看"
              ),
              "info"
            );
          });
        return;
      }
    } catch (e) {
      /* fallthrough */
    }
    notify(
      i18n(
        "gSyncOpenDocHint",
        "冲突文档已生成在原文档旁(文件名含 _conflict_ 前缀),请在左侧文件树中打开查看"
      ),
      "info"
    );
  }

  /** 弹出冲突处理对话框(持久,直到用户选择) */
  function showConflictDialog() {
    const conflict = host.conflictDetail || {};
    const pathText = conflict.path || "";
    try {
      closeDialog();
      const dialogInstance = new q.Dialog({
        title: i18n("gSyncConflictTitle", "⚠️ 检测到同步冲突"),
        content:
          '<div class="b3-dialog__content">' +
          '<div class="b3-label__text" style="margin-bottom:8px">' +
          i18n(
            "gSyncConflictDesc",
            "本地与远端的数据同时被修改,自动同步已暂停。请选择处理方式:"
          ) +
          "</div>" +
          '<div class="b3-label" style="margin-bottom:12px">' +
          '<span class="b3-label__text">' +
          i18n("gSyncConflictFile", "冲突文件") +
          ":</span> " +
          '<code style="word-break:break-all">' +
          escapeHtml(pathText) +
          "</code>" +
          "</div>" +
          '<div class="fn__flex" style="gap:8px;flex-wrap:wrap">' +
          '<button class="b3-button b3-button--text" id="gSyncKeepLocal" style="flex:1;min-width:40%">' +
          i18n("gSyncKeepLocal", "保留本地版本") +
          "</button>" +
          '<button class="b3-button b3-button--text" id="gSyncKeepRemote" style="flex:1;min-width:40%">' +
          i18n("gSyncKeepRemote", "保留远端版本") +
          "</button>" +
          '<button class="b3-button b3-button--text" id="gSyncOpenDoc" style="flex:1;min-width:40%">' +
          i18n("gSyncOpenConflictDoc", "打开冲突文档") +
          "</button>" +
          '<button class="b3-button b3-button--cancel" id="gSyncLater" style="flex:1;min-width:40%">' +
          i18n("gSyncLater", "稍后处理") +
          "</button>" +
          "</div>" +
          "</div>",
        width: "560px",
        hideCloseIcon: false,
        destroyCallback: function () {
          host.dialog = null;
        },
      });
      host.dialog = dialogInstance;
      const root = dialogInstance.element;
      const bind = function (id, fn) {
        try {
          const btn = root && root.querySelector("#" + id);
          if (btn) btn.addEventListener("click", fn);
        } catch (e) {
          /* ignore */
        }
      };
      bind("gSyncKeepLocal", function () {
        resolveKeepLocal();
      });
      bind("gSyncKeepRemote", function () {
        resolveKeepRemote();
      });
      bind("gSyncOpenDoc", function () {
        openConflictDoc();
      });
      bind("gSyncLater", function () {
        closeDialog();
        notify(
          i18n(
            "gSyncLaterMsg",
            "冲突仍待处理:自动同步保持暂停,恢复后请及时处理"
          ),
          "info"
        );
      });
    } catch (e) {
      console.error("git-sync: showConflictDialog", e);
    }
  }

  function reopenConflictDialog() {
    notify(
      i18n("gSyncPausedMsg", "⚠️ 同步冲突未解决,自动同步已暂停,请先处理冲突"),
      "error"
    );
    if (!host.dialog) {
      showConflictDialog();
    }
  }

  /** 用户选择: 保留本地版本 → 强制「本地覆盖远端」 */
  function resolveKeepLocal() {
    closeDialog();
    return plugin.syncDataToCloud(STRATEGY.LOCAL_OVER_REMOTE, true);
  }

  /** 用户选择: 保留远端版本 → 强制「远端覆盖本地」 */
  function resolveKeepRemote() {
    closeDialog();
    return plugin.syncDataToCloud(STRATEGY.REMOTE_OVER_LOCAL, true);
  }

  /** 冲突处理: 置冲突状态 → 暂停自动同步 → 通知 → 弹窗 */
  function handleConflict(err) {
    const info = extractConflictInfo(err);
    host.state = SyncState.CONFLICT;
    host.conflictDetail = info;
    host.pausedSince = Date.now();
    host.pausedTimer = false;
    pauseAutoSync();
    host.state = SyncState.CONFLICT_PAUSED;
    host.autoSkipNotified = false;
    setBadge();
    persist();
    notify(i18n("gSyncConflictMsg", "🔴 检测到同步冲突,自动同步已暂停"), "error");
    showConflictDialog();
    return undefined;
  }

  /**
   * 同步入口包装(替换原 syncDataToCloud):
   *  - 冲突暂停状态下: 拦截自动同步/普通手动触发,放行用户的明确解决动作
   *  - 正常: 原逻辑 + 同步状态机 + 冲突接管
   */
  async function runSync(t, s) {
    const prevState = host.state;
    // 用户的「明确解决动作」: 强制 远端覆盖本地 / 本地覆盖远端
    const isResolution =
      t === STRATEGY.REMOTE_OVER_LOCAL || t === STRATEGY.LOCAL_OVER_REMOTE;

    if (isPausedConflict()) {
      if (isResolution) {
        // 用户明确选择了解决方向 → 放行,进入解决流程
        host.wasConflictFlow = true;
        host.state = SyncState.RESOLVING;
        setBadge();
      } else {
        const autoTick = consumeAutoTick();
        if (!autoTick) {
          // 用户手动点击开始同步 / 选择方向: 重新弹窗引导先处理冲突
          reopenConflictDialog();
        } else if (!host.autoSkipNotified) {
          // 自动同步定时器: 静默跳过,一个暂停会话只提示一次
          host.autoSkipNotified = true;
          notify(
            i18n(
              "gSyncPausedMsg",
              "⚠️ 同步冲突未解决,自动同步已暂停,请处理冲突"
            ),
            "error"
          );
        }
        return undefined;
      }
    } else {
      host.state = SyncState.RUNNING;
      setBadge();
    }

    try {
      const result = await plugin.__gSyncDataToCloudBase(t, s);

      if (host.wasConflictFlow) {
        // 冲突解决流程完成
        host.wasConflictFlow = false;
        host.conflictDetail = null;
        host.pausedSince = 0;
        host.autoSkipNotified = false;
        host.state = SyncState.RESOLVED;
        setBadge();
        persist();
        resumeAutoSync();
        notify(
          i18n("gSyncResolvedMsg", "✅ 冲突已处理,自动同步已恢复"),
          "info"
        );
        return result;
      }

      host.state = SyncState.SUCCESS;
      setBadge();
      return result;
    } catch (err) {
      if (isConflictError(err)) {
        return handleConflict(err);
      }
      // 「正在同步中」的保护错误视为良性,不改变状态
      const benign =
        err &&
        plugin &&
        plugin.i18n &&
        typeof err.message === "string" &&
        err.message === plugin.i18n.isSyncingInfo;
      if (host.wasConflictFlow) {
        // 解决冲突的同步失败 → 回到暂停态,等待用户重试
        host.wasConflictFlow = false;
        host.state = SyncState.CONFLICT_PAUSED;
        setBadge();
        notify(
          i18n(
            "gSyncResolveFailedMsg",
            "❌ 处理冲突的同步失败,冲突仍待处理"
          ),
          "error"
        );
        showConflictDialog();
      } else if (!benign) {
        host.state = SyncState.FAILED;
        setBadge();
        const message = formatErrorSummary(err);
        addLog("error", "同步失败: " + message);
        notify("❌ 同步失败: " + message, "error");
      } else {
        // 「正在同步中」的良性保护错误: 恢复进入前的状态
        host.state = prevState;
      }
      throw err; // 非冲突错误保持原行为(由原异常处理器 toast / 记日志)
    }
  }

  // 挂载公开方法到宿主
  host.i18n = i18n;
  host.notify = notify;
  host.addLog = addLog;
  host.showRuntimeLogs = showRuntimeLogs;
  host.setBadge = setBadge;
  host.persist = persist;
  host.onAfterLoad = onAfterLoad;
  host.attachBadge = attachBadge;
  host.markAutoTick = markAutoTick;
  host.consumeAutoTick = consumeAutoTick;
  host.isPausedConflict = isPausedConflict;
  host.pauseAutoSync = pauseAutoSync;
  host.resumeAutoSync = resumeAutoSync;
  host.closeDialog = closeDialog;
  host.openConflictDoc = openConflictDoc;
  host.showConflictDialog = showConflictDialog;
  host.reopenConflictDialog = reopenConflictDialog;
  host.resolveKeepLocal = resolveKeepLocal;
  host.resolveKeepRemote = resolveKeepRemote;
  host.handleConflict = handleConflict;
  host.runSync = runSync;

  // 把宿主句柄挂到插件实例上(便于调试/测试访问,不影响插件行为)
  try {
    plugin.__gSyncFlowHost = host;
  } catch (e) {
    /* ignore */
  }

  return host;
}

/** 兜底: 某些宿主环境没有全局 setInterval 安全包装时使用 */
function setIntervalSafe(fn, ms) {
  try {
    return setTimeout(fn, ms);
  } catch (e) {
    try {
      fn();
    } catch (e2) {
      /* ignore */
    }
    return 0;
  }
}