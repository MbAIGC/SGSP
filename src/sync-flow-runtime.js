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

/** 同步历史持久化文件名(环形保留最近 N 次同步结果,重启后可查) */
export const HISTORY_FILE = "git-sync-history.json";

/** 同步历史最多保留条数 */
export const HISTORY_LIMIT = 50;

/** 错误分类的用户可见中文文案 */
export const CATEGORY_LABEL = Object.freeze({
  NETWORK: "网络连接失败",
  AUTH: "Token 无效,请重新配置",
  PERMISSION: "权限不足或 API 限流",
  REPOSITORY: "仓库不存在,请检查设置",
  BRANCH: "分支不存在,请检查设置",
  CONFLICT: "文件冲突,已暂停",
  PUSH_REJECTED: "远端已更新,重新同步",
  BLOB_LIMIT: "文件过大,已跳过",
  GIT_API: "Git API 错误",
  UNKNOWN: "未知错误",
});

/**
 * 错误分类器(M1 基础版): 沿 cause 链收集特征并归类。
 * 只做展示/重试决策,不改变「非冲突错误重抛」的语义。
 * @returns {{category:string,retryable:boolean,recoverable:boolean,status:number,path:string,message:string}}
 */
export function classifyError(err) {
  let node = err;
  let status = 0;
  let path = "";
  let message = "";
  let conflict = false;
  for (let i = 0; node && i < 7; i++) {
    if (node.code === CONFLICT_CODE) conflict = true;
    if (!status) {
      const st = node.status || (node.response && node.response.status) || 0;
      if (st) status = st;
    }
    if (!path && node.path) path = node.path;
    if (!message && node.message) message = String(node.message);
    node = node.cause;
  }
  const text = (message || "").toLowerCase();
  const needUser = { retryable: false, recoverable: true };
  if (conflict) {
    return { category: "CONFLICT", retryable: false, recoverable: true, status: status, path: path, message: message };
  }
  if (status === 401) {
    return { category: "AUTH", retryable: false, recoverable: true, status: status, path: path, message: message };
  }
  if (status === 403) {
    return { category: "PERMISSION", retryable: false, recoverable: true, status: status, path: path, message: message };
  }
  if (status === 404) {
    const cat = /branch|分支|ref/i.test(text) ? "BRANCH" : "REPOSITORY";
    return { category: cat, retryable: false, recoverable: true, status: status, path: path, message: message };
  }
  if (status === 409 || status === 422) {
    return { category: "PUSH_REJECTED", retryable: true, recoverable: false, status: status, path: path, message: message };
  }
  if (status === 413) {
    return { category: "BLOB_LIMIT", retryable: false, recoverable: true, status: status, path: path, message: message };
  }
  if (status >= 400) {
    return { category: "GIT_API", retryable: true, recoverable: false, status: status, path: path, message: message };
  }
  if (/(timeout|econn|enotfound|aborted|aborterror|socket|network|连接|网络|超时|dns)/i.test(text)) {
    return { category: "NETWORK", retryable: true, recoverable: false, status: status, path: path, message: message };
  }
  if (/(limited|过大|超过|too large|exceed|file size)/i.test(text)) {
    return { category: "BLOB_LIMIT", retryable: false, recoverable: true, status: status, path: path, message: message };
  }
  return { category: "UNKNOWN", retryable: true, recoverable: false, status: status, path: path, message: message };
}

/**
 * 极简事件总线(on/off/emit),不引依赖,遵守注入语法约束。
 * 用于同步层与通知层解耦: sync:start / sync:success / sync:error / sync:conflict / sync:paused / sync:resumed / sync:history
 */
export function createEventBus() {
  const handlers = {};
  return {
    on: function (name, fn) {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(fn);
      return this;
    },
    off: function (name, fn) {
      const list = handlers[name];
      if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] === fn) list.splice(i, 1);
        }
      }
      return this;
    },
    emit: function (name, payload) {
      const list = handlers[name] || [];
      for (let i = 0; i < list.length; i++) {
        try {
          list[i](payload);
        } catch (e) {
          /* 订阅者异常不影响主流程 */
        }
      }
      return this;
    },
  };
}

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

/**
 * 从错误链中提取冲突信息(路径/消息)。
 * M1 增强: 收集 cause 链中**所有** code===300 的节点,返回 conflicts 列表与数量;
 * 同时保留旧字段 path/message/name(取第一个冲突),兼容既有调用与测试。
 */
export function extractConflictInfo(err) {
  const conflicts = [];
  let node = err;
  for (let i = 0; node && i < 7; i++) {
    if (node.code === CONFLICT_CODE) {
      conflicts.push({
        path: node.path || "",
        message: node.message || "",
        name: node.name || "CONFLICT",
      });
    }
    node = node.cause;
  }
  if (conflicts.length === 0) {
    return {
      path: "",
      message: String((err && err.message) || err),
      name: "",
      conflicts: [],
      conflictCount: 0,
    };
  }
  const first = conflicts[0];
  return {
    path: first.path,
    message: first.message,
    name: first.name,
    conflicts: conflicts,
    conflictCount: conflicts.length,
  };
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 错误摘要(M1 增强): 遍历**完整** cause 链,同时保留:
 *  - 最外层 HTTP 状态(第一个出现的 status);
 *  - 最具体文件路径(第一个出现的 path);
 *  - 最底层消息(链末端节点的 response.data.message / message)。
 * 不再「遇到第一个带 status 的节点就返回」,避免丢失更具体的底层信息。
 */
function getErrorSummary(err) {
  let node = err;
  let status = 0;
  let path = "";
  let message = "";
  let fallback = "";
  for (let i = 0; node && i < 7; i++) {
    if (!status) {
      const st = node.status || (node.response && node.response.status) || 0;
      if (st) status = st;
    }
    if (!path && node.path) path = node.path;
    const data = (node.response && node.response.data) || {};
    const m = data.message || node.message || "";
    if (m) message = String(m);
    if (!fallback && node.message) fallback = String(node.message);
    node = node.cause;
  }
  return {
    message: message || fallback || String((err && err.message) || err || "未知错误"),
    status: status || 0,
    path: path || "",
  };
}

/** 脱敏: 隐藏 token / 密码 / Authorization 头等敏感信息 */
function redactText(text) {
  return String(text == null ? "" : text)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [已隐藏]")
    .replace(/(token|password|authorization|cookie)\s*[:=]\s*[^,;\s]+/gi, "$1=[已隐藏]");
}

function formatErrorSummary(err) {
  const summary = getErrorSummary(err);
  const message = redactText(summary.message);
  let output = message;
  if (summary.status) output = "HTTP " + summary.status + ": " + output;
  if (summary.path) output += " (文件: " + summary.path + ")";
  return output.slice(0, 500);
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
    // M1: 同步历史(环形,重启后可查)与事件总线
    history: [],
    operationSeq: 0,
    currentOperationId: "",
    events: createEventBus(),
    // M1.1: 本次同步的文件操作统计(patch 在 addFileToWorkArea 注入 trackFile 填充)
    syncStats: { create: [], update: [], delete: [] },
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

  /** 生成一次同步的 operationId(贯通通知/历史/日志) */
  function nextOperationId() {
    host.operationSeq += 1;
    return "sync-" + Date.now() + "-" + host.operationSeq;
  }

  /** 发送同步事件(订阅者异常不影响主流程) */
  function emitSync(name, payload) {
    try {
      host.events.emit(name, payload);
    } catch (e) {
      /* ignore */
    }
  }

  /** 读取「成功时通知」开关(默认开) */
  function isSyncNotifyEnabled() {
    try {
      const v = plugin && plugin.settingUtils ? plugin.settingUtils.get("sgsp_sync_notify") : undefined;
      return v === undefined || v === null || v === "" ? true : !!v;
    } catch (e) {
      return true;
    }
  }

  /**
   * 记录本次同步的一个文件操作(patch 在 addFileToWorkArea 注入调用)。
   * op: "create" | "update" | "delete"; path: 文件路径。
   * 每类最多保留 100 条,防止超大同步刷爆内存。
   */
  function trackFile(op, path) {
    try {
      if (!host.syncStats) {
        host.syncStats = { create: [], update: [], delete: [] };
      }
      const key = op === "create" ? "create" : op === "delete" ? "delete" : "update";
      const list = host.syncStats[key];
      if (list && path && list.length < 100) {
        list.push(String(path));
      }
    } catch (e) {
      /* 统计失败不影响同步主流程 */
    }
  }

  /**
   * 生成「本次同步文件」明细行(patch 注入的 trackFile 数据)。
   * 每类最多列出前 5 个路径,超出以「等 N 个」省略。
   */
  function buildFileStatsText() {
    const stats = host.syncStats || { create: [], update: [], delete: [] };
    const parts = [];
    const cats = [
      ["create", i18n("gSyncCreatedLabel", "新增")],
      ["update", i18n("gSyncUpdatedLabel", "更新")],
      ["delete", i18n("gSyncDeletedLabel", "删除")],
    ];
    for (let idx = 0; idx < cats.length; idx++) {
      const list = stats[cats[idx][0]] || [];
      if (list.length > 0) {
        parts.push(
          cats[idx][1] +
            " " +
            list.length +
            " 个 (" +
            list.slice(0, 5).join(", ") +
            (list.length > 5 ? " 等" : "") +
            ")"
        );
      }
    }
    return parts.length > 0
      ? i18n("gSyncFilesDetailLabel", "本次同步文件") + ": " + parts.join("; ")
      : "";
  }

  /** 记录一条同步历史并持久化(环形保留,失败可观测) */
  function addHistoryEntry(entry) {
    const item = {
      operationId: entry.operationId || host.currentOperationId || "",
      time: new Date().toISOString(),
      state: entry.state || host.state || "",
      category: entry.category || "",
      message: String(entry.message == null ? "" : entry.message).slice(0, 300),
      fileCount: entry.fileCount || 0,
      retries: entry.retries || 0,
    };
    host.history.push(item);
    if (host.history.length > HISTORY_LIMIT) host.history.shift();
    emitSync("sync:history", item);
    try {
      plugin
        .saveData(HISTORY_FILE, { entries: host.history })
        .catch(function (err) {
          addLog("error", "同步历史保存失败: " + ((err && err.message) || err));
          notify(i18n("gSyncHistorySaveFailed", "⚠️ 同步历史保存失败"), "error");
        });
    } catch (e) {
      addLog("error", "同步历史保存失败: " + ((e && e.message) || e));
    }
  }

  function notify(msg, type) {
    addLog(type === "error" ? "error" : "info", msg);
    try {
      q.showMessage(msg, 3000, type || "info");
    } catch (e) {
      /* 通知失败不影响主流程 */
    }
  }

  /** 打开运行日志面板(每 1 秒自动刷新,同步进行中的新条目会实时出现) */
  function showRuntimeLogs() {
    let dialog = null;
    let closed = false;
    // 构建条目 HTML(空日志给出占位提示)
    const buildRows = function () {
      return host.logEntries.length
        ? host.logEntries
            .map(function (entry) {
              return "<div><strong>[" + escapeHtml(entry.level.toUpperCase()) + "] " + escapeHtml(entry.time) + "</strong> " + escapeHtml(entry.message) + "</div>";
            })
            .join("")
        : "<div>暂无运行日志</div>";
    };
    // 渲染一帧: 重建条目 HTML
    const render = function () {
      try {
        if (!closed && dialog && dialog.element && dialog.element.querySelector) {
          const box = dialog.element.querySelector("#gSyncRuntimeLogBox");
          if (box) box.innerHTML = buildRows();
        }
      } catch (e) {
        /* 面板已关闭或宿主 DOM 不支持时忽略 */
      }
    };
    try {
      dialog = new q.Dialog({
        title: i18n("gSyncRuntimeLogsTitle", "SGSP 运行日志"),
        content:
          '<div class="fn__flex-column" id="gSyncRuntimeLogBox" style="height:100%;overflow:auto;padding:8px;font-family:monospace;white-space:pre-wrap;">' +
          buildRows() +
          "</div>",
        width: "80vw",
        height: "70vh",
        destroyCallback: function () {
          closed = true;
        },
      });
    } catch (err) {
      addLog("error", "打开运行日志失败: " + (err && err.message ? err.message : err));
      try { q.showMessage("❌ 无法打开 SGSP 运行日志", 3000, "error"); } catch (e) {}
      return;
    }
    // 实时刷新循环(面板关闭后停止,避免泄漏)
    const tick = function () {
      if (closed) return;
      render();
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
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
        const cd = host.conflictDetail || {};
        plugin
          .saveData(DATA_FILE, {
            state: host.state,
            conflictDetail: {
              path: cd.path || "",
              message: cd.message || "",
              name: cd.name || "",
              conflicts: cd.conflicts || [],
              conflictCount: cd.conflictCount || (cd.conflicts ? cd.conflicts.length : 0),
            },
            pausedSince: host.pausedSince,
            pausedTimer: host.pausedTimer,
          })
          .catch(function (err) {
            // M1: 持久化失败不再静默吞掉,保持内存态暂停并提示
            addLog("error", "冲突状态持久化失败: " + ((err && err.message) || err));
            notify(i18n("gSyncPersistFailed", "⚠️ 冲突状态保存失败,重启后可能丢失暂停状态"), "error");
          });
      } else {
        plugin
          .saveData(DATA_FILE, { state: SyncState.IDLE })
          .catch(function (err) {
            // M1: 持久化失败可观测(不静默)
            addLog("error", "状态持久化失败: " + ((err && err.message) || err));
            notify(i18n("gSyncPersistFailed", "⚠️ 状态保存失败,重启后可能丢失暂停状态"), "error");
          });
      }
    } catch (e) {
      // 持久化失败不影响主流程(冲突暂停会自动重新建立),但需可观测
      addLog("error", "持久化异常: " + ((e && e.message) || e));
    }
  }

  /** onload 时调用: 恢复上次未解决的冲突暂停状态 + 同步历史 */
  function onAfterLoad() {
    try {
      host.restorePromise = Promise.resolve(plugin.loadData(DATA_FILE));
    } catch (e) {
      host.restorePromise = Promise.reject(e);
    }
    // M1: 恢复同步历史(失败仅记日志,不影响冲突恢复)
    try {
      Promise.resolve(plugin.loadData(HISTORY_FILE))
        .then(function (data) {
          if (data && Array.isArray(data.entries)) {
            host.history = data.entries.slice(0, HISTORY_LIMIT);
          }
        })
        .catch(function (err) {
          addLog("error", "同步历史恢复失败: " + ((err && err.message) || err));
        });
    } catch (e) {
      addLog("error", "同步历史恢复失败: " + ((e && e.message) || e));
    }
    return host.restorePromise
      .then(function (data) {
        if (data && data.state === SyncState.CONFLICT_PAUSED) {
          const raw = data.conflictDetail || {};
          // 旧版本持久化只有单文件字段,迁移为 conflicts 数组
          let conflicts = Array.isArray(raw.conflicts) && raw.conflicts.length
            ? raw.conflicts
            : raw.path || raw.message
              ? [{ path: raw.path || "", message: raw.message || "", name: raw.name || "CONFLICT" }]
              : [];
          host.conflictDetail = {
            path: conflicts.length ? conflicts[0].path : "",
            message: conflicts.length ? conflicts[0].message : "",
            name: conflicts.length ? conflicts[0].name : "",
            conflicts: conflicts,
            conflictCount: conflicts.length,
          };
          host.state = SyncState.CONFLICT_PAUSED;
          host.pausedSince = data.pausedSince || Date.now();
          // 旧状态文件没有 pausedTimer 时,按自动模式兼容恢复定时器。
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
    const conflicts = Array.isArray(conflict.conflicts) ? conflict.conflicts : [];
    const pathText = conflicts.length ? conflicts[0].path || "" : conflict.path || "";
    // M1: 多冲突时展示数量与文件列表(最多列出前 10 个)
    let listHtml = "";
    if (conflicts.length > 1) {
      const shown = conflicts.slice(0, 10);
      listHtml =
        '<div style="max-height:140px;overflow:auto;border-top:1px solid var(--b3-theme-background-light);margin-top:8px;padding-top:6px">' +
        shown
          .map(function (c) {
            return '<div style="word-break:break-all;font-size:12px;padding:2px 0">• ' + escapeHtml(c.path || "") + "</div>";
          })
          .join("") +
        (conflicts.length > 10 ? '<div style="font-size:12px;opacity:.6">…等 ' + conflicts.length + " 个文件</div>" : "") +
        "</div>";
    }
    try {
      closeDialog();
      const dialogInstance = new q.Dialog({
        title:
          i18n("gSyncConflictTitle", "⚠️ 检测到同步冲突") +
          (conflicts.length > 1 ? "(" + conflicts.length + " 个文件)" : ""),
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
          listHtml +
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
    // M1: 冲突事件 + 历史记录 + 数量通知
    emitSync("sync:conflict", { conflictDetail: info, conflictCount: info.conflictCount });
    addHistoryEntry({
      state: SyncState.CONFLICT_PAUSED,
      category: "CONFLICT",
      message: info.message || i18n("gSyncConflictMsg", "检测到同步冲突"),
      fileCount: info.conflictCount,
    });
    notify(
      i18n("gSyncConflictMsg", "🔴 检测到同步冲突,自动同步已暂停") +
        (info.conflictCount > 1 ? "(" + info.conflictCount + " 个文件)" : ""),
      "error"
    );
    showConflictDialog();
    return undefined;
  }

  /**
   * 同步入口包装(替换原 syncDataToCloud):
   *  - 冲突暂停状态下: 拦截自动同步/普通手动触发,放行用户的明确解决动作
   *  - 正常: 原逻辑 + 同步状态机 + 冲突接管
   *  - M1: 开始/成功/失败即时通知 + 事件总线 + 同步历史
   */
  async function runSync(t, s) {
    const prevState = host.state;
    // 每轮同步开始重置文件操作统计(patch 注入的 trackFile 会重新填充)
    host.syncStats = { create: [], update: [], delete: [] };
    // 用户的「明确解决动作」: 强制 远端覆盖本地 / 本地覆盖远端
    const isResolution =
      t === STRATEGY.REMOTE_OVER_LOCAL || t === STRATEGY.LOCAL_OVER_REMOTE;

    if (isPausedConflict()) {
      if (isResolution) {
        // 用户明确选择了解决方向 → 放行,进入解决流程
        host.wasConflictFlow = true;
        host.state = SyncState.RESOLVING;
        setBadge();
        host.currentOperationId = nextOperationId();
        emitSync("sync:start", { operationId: host.currentOperationId, phase: "resolve" });
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
      // M1: 非暂停路径读取并消费 autoTick 标记(定时触发只记日志不 toast,避免轰炸)
      const wasAutoTick = host.autoTick;
      host.autoTick = false;
      host.state = SyncState.RUNNING;
      setBadge();
      host.currentOperationId = nextOperationId();
      const startMsg = i18n("gSyncStartMsg", "🔄 开始同步...");
      addLog("info", startMsg);
      emitSync("sync:start", { operationId: host.currentOperationId });
      if (!wasAutoTick) {
        notify(startMsg, "info");
      }
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
        addHistoryEntry({
          state: SyncState.RESOLVED,
          category: "",
          message: i18n("gSyncResolvedMsg", "✅ 冲突已处理,自动同步已恢复"),
        });
        emitSync("sync:success", { operationId: host.currentOperationId });
        emitSync("sync:resumed", { operationId: host.currentOperationId });
        notify(
          i18n("gSyncResolvedMsg", "✅ 冲突已处理,自动同步已恢复"),
          "info"
        );
        return result;
      }

      host.state = SyncState.SUCCESS;
      setBadge();
      const stats = host.syncStats || { create: [], update: [], delete: [] };
      const created = stats.create.length;
      const updated = stats.update.length;
      const deleted = stats.delete.length;
      const total = created + updated + deleted;
      let successMsg = i18n("gSyncSuccessMsg", "✅ 同步成功");
      if (total > 0) {
        // 有文件变更: 成功消息带数量摘要,明细单独写入运行日志
        successMsg =
          successMsg +
          "(" +
          i18n("gSyncCreatedLabel", "新增") +
          " " +
          created +
          ", " +
          i18n("gSyncUpdatedLabel", "更新") +
          " " +
          updated +
          ", " +
          i18n("gSyncDeletedLabel", "删除") +
          " " +
          deleted +
          ")";
        addLog("info", successMsg);
        const statsDetail = buildFileStatsText();
        if (statsDetail) {
          addLog("info", statsDetail);
        }
      } else {
        // 无文件变更: 明确提示已停止同步,避免用户误以为没有执行
        successMsg =
          successMsg +
          "(" +
          i18n("gSyncNoChangeMsg", "未检测到文件变更,已停止同步") +
          ")";
        addLog("info", successMsg);
      }
      addHistoryEntry({
        state: SyncState.SUCCESS,
        category: "",
        message: successMsg,
      });
      emitSync("sync:success", {
        operationId: host.currentOperationId,
        fileStats: { created: created, updated: updated, deleted: deleted },
      });
      if (isSyncNotifyEnabled()) {
        notify(successMsg, "info");
      }
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
      const classified = classifyError(err);
      const label = CATEGORY_LABEL[classified.category] || CATEGORY_LABEL.UNKNOWN;
      if (host.wasConflictFlow) {
        // 解决冲突的同步失败 → 回到暂停态,等待用户重试
        host.wasConflictFlow = false;
        host.state = SyncState.CONFLICT_PAUSED;
        setBadge();
        addHistoryEntry({
          state: SyncState.CONFLICT_PAUSED,
          category: classified.category,
          message: formatErrorSummary(err),
        });
        emitSync("sync:error", {
          operationId: host.currentOperationId,
          category: classified.category,
          retryable: classified.retryable,
          recoverable: classified.recoverable,
          message: formatErrorSummary(err),
        });
        notify(
          i18n(
            "gSyncResolveFailedMsg",
            "❌ 处理冲突的同步失败,冲突仍待处理"
          ) + "(" + label + ")",
          "error"
        );
        showConflictDialog();
      } else if (!benign) {
        host.state = SyncState.FAILED;
        setBadge();
        const message = formatErrorSummary(err);
        addLog("error", "同步失败: " + message + " [" + classified.category + "]");
        addHistoryEntry({
          state: SyncState.FAILED,
          category: classified.category,
          message: message,
        });
        emitSync("sync:error", {
          operationId: host.currentOperationId,
          category: classified.category,
          retryable: classified.retryable,
          recoverable: classified.recoverable,
          message: message,
        });
        notify("❌ 同步失败: " + message + "(" + label + ")", "error");
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
  host.trackFile = trackFile;
  host.buildFileStatsText = buildFileStatsText;
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
  // M1: 事件总线 / 历史 / 通知开关
  host.events = host.events || createEventBus();
  host.emitSync = emitSync;
  host.addHistoryEntry = addHistoryEntry;
  host.isSyncNotifyEnabled = isSyncNotifyEnabled;
  host.classifyError = classifyError;
  host.getErrorSummary = getErrorSummary;

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