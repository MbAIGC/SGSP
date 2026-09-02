/**
 * GIT 同步插件 —— 冲突处理闭环运行时单元测试
 * 运行: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SyncState,
  SETTING,
  STRATEGY,
  SYNC_MODE,
  CONFLICT_CODE,
  isConflictError,
  extractConflictInfo,
  createSyncFlowHost,
  classifyError,
  createEventBus,
  DATA_FILE,
  HISTORY_FILE,
  HISTORY_LIMIT,
} from "../src/sync-flow-runtime.js";

/** 构造一个假插件实例(模拟 q.Plugin 子类暴露给宿主的能力) */
function makeFakePlugin(opts = {}) {
  const settings = Object.assign(
    {
      [SETTING.syncMode]: String(SYNC_MODE.AUTO),
      [SETTING.syncInterval]: 600000,
      [SETTING.enabledSync]: true,
    },
    opts.settings || {}
  );
  const calls = [];
  const dataStore = {};

  const plugin = {
    i18n: Object.assign(
      {
        isSyncingInfo: "正在同步中",
        addTopBarIcon: "SGSP",
      },
      opts.i18n || {}
    ),
    topBarElement: {
      title: "",
      classList: {
        classes: new Set(),
        add(c) {
          this.classes.add(c);
        },
        remove(c) {
          this.classes.delete(c);
        },
      },
    },
    settingUtils: {
      get(k) {
        return settings[k];
      },
      setAndSave(k, v) {
        settings[k] = v;
      },
    },
    timerTask: null,
    startAutoSync(fn) {
      calls.push(["startAutoSync"]);
      plugin.__autoFn = fn;
    },
    saveData(name, payload) {
      dataStore[name] = payload;
      return Promise.resolve();
    },
    loadData(name) {
      return Promise.resolve(dataStore[name] || null);
    },
    __gSyncDataToCloudBase: null, // 由测试注入
    _calls: calls,
    _settings: settings,
    _data: dataStore,
    syncDataToCloud(t, s) {
      // 模拟补丁后的包装方法
      return plugin.__gSyncFlowHost ? plugin.__gSyncFlowHost.runSync(t, s) : Promise.resolve();
    },
  };

  // 默认 base 实现
  plugin.__gSyncDataToCloudBase = opts.baseSync
    ? opts.baseSync
    : async function (t, s) {
        calls.push(["sync", t, s]);
        if (opts.conflictOnSync && s !== true) {
          // 模拟 bundle 中冲突错误被 Jt/Ht 包装的错误链(强制模式不产生冲突)
          const conflictErr = {
            name: "Mr",
            code: CONFLICT_CODE,
            path: "data/notebook/doc.sy",
            message: "⚠文档冲突:",
          };
          const wrapped = { name: "Jt", code: -100, message: "promise 任务出错", cause: conflictErr };
          throw { name: "Ht", code: 204, message: "同步失败", cause: wrapped };
        }
        return { sha: "abc123" };
      };

  const q = opts.q || makeFakeQ();
  plugin._q = q;

  // 创建宿主并挂到插件上(模拟 __gEnsureSyncFlow)
  plugin.__gSyncFlowHost = createSyncFlowHost(plugin, q);
  return plugin;
}

function makeFakeQ() {
  const msgs = [];
  const dialogs = [];
  const q = {
    _msgs: msgs,
    _dialogs: dialogs,
    showMessage(msg, timeout, type) {
      msgs.push({ msg, timeout, type });
    },
    Dialog: class {
      constructor(opts) {
        this.opts = opts;
        // 假 DOM: 记录按钮点击回调
        this.listeners = {};
        this.destroyed = false;
        this.element = {
          querySelector(id) {
            return {
              id,
              addEventListener(evt, fn) {
                q._dialogs[q._dialogs.length - 1].listeners[id] = fn;
              },
            };
          },
        };
        dialogs.push(this);
      }
      destroy() {
        this.destroyed = true;
        if (this.opts && this.opts.destroyCallback) this.opts.destroyCallback();
      }
    },
    fetchSyncPost() {
      return Promise.resolve({ data: { documents: [] } });
    },
    openTab() {},
  };
  return q;
}

test("初始状态为 IDLE", () => {
  const p = makeFakePlugin();
  assert.equal(p.__gSyncFlowHost.state, SyncState.IDLE);
});

test("正常同步: RUNNING → SUCCESS", async () => {
  const p = makeFakePlugin();
  const host = p.__gSyncFlowHost;
  const ret = await host.runSync(undefined, false);
  assert.equal(host.state, SyncState.SUCCESS);
  assert.ok(ret && ret.sha === "abc123");
  assert.deepEqual(p._calls[0], ["sync", undefined, false]);
});

test("冲突检测: 能穿透 Jt/Ht 包装的错误链找到 code===300", () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  p.__gSyncDataToCloudBase().catch((err) => {
    assert.ok(isConflictError(err), "应识别出被包装的冲突错误");
    const info = extractConflictInfo(err);
    assert.equal(info.path, "data/notebook/doc.sy");
    assert.equal(info.code, undefined); // extractConflictInfo 返回 {path,message,name}
    assert.equal(info.name, "Mr");
  });
});

test("冲突发生时: 进入 CONFLICT_PAUSED, 暂停定时器, 弹窗, 持久化, 顶栏红色徽标", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  const host = p.__gSyncFlowHost;
  p.timerTask = { removeSelf() { p._timerRemoved = true; } };
  const ret = await host.runSync(undefined, false);
  assert.equal(host.state, SyncState.CONFLICT_PAUSED);
  assert.equal(p._timerRemoved, true, "应暂停自动同步定时器");
  assert.ok(host.dialog, "应弹出冲突处理对话框");
  assert.equal(host.conflictDetail.path, "data/notebook/doc.sy");
  assert.ok(p.topBarElement.classList.classes.has("git-sync-conflict-paused"), "顶栏应有红色徽标");
  assert.ok(p._data[DATA_FILE] && p._data[DATA_FILE].state === SyncState.CONFLICT_PAUSED, "应持久化暂停状态");
  assert.equal(ret, undefined, "冲突被接管后不应抛出");
  // 通知
  const q = p.__gSyncFlowHost.q;
  assert.ok(q._msgs.some((m) => m.type === "error"), "应有错误级通知");
});

test("暂停后自动同步定时触发: 静默跳过, 同一会话只提示一次", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  const host = p.__gSyncFlowHost;
  await host.runSync(undefined, false); // 触发冲突 → 暂停
  const before = host.q._msgs.length;
  // 定时器触发(带 autoTick 标记), 多次
  host.markAutoTick();
  const r1 = await host.runSync(undefined, false);
  host.markAutoTick();
  const r2 = await host.runSync(undefined, false);
  assert.equal(r1, undefined);
  assert.equal(r2, undefined);
  assert.equal(host.state, SyncState.CONFLICT_PAUSED, "状态保持暂停");
  // 只多出一条提示(会话内第一次)
  assert.equal(host.q._msgs.length, before + 1);
});

test("暂停后用户手动点击开始同步: 重新弹窗引导, 不触发同步", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  const host = p.__gSyncFlowHost;
  await host.runSync(undefined, false); // 冲突暂停
  host.closeDialog(); // 用户之前点了稍后处理
  assert.equal(host.dialog, null);
  const syncCallsBefore = p._calls.filter((c) => c[0] === "sync").length;
  await host.runSync(undefined, false); // 手动点击(无 autoTick)
  assert.ok(host.dialog, "应重新弹出冲突处理对话框");
  assert.equal(p._calls.filter((c) => c[0] === "sync").length, syncCallsBefore, "不应真正执行同步");
});

test("用户选择「保留本地版本」: 强制本地覆盖远端 → 解决 → 恢复自动同步", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  p.startAutoSync = function (fn) { p._calls.push(["startAutoSync"]); p._autoFn = fn; };
  const host = p.__gSyncFlowHost;
  p.timerTask = { removeSelf() { p._timerRemoved = true; } };
  await host.runSync(undefined, false); // 冲突 → 暂停
  assert.equal(host.state, SyncState.CONFLICT_PAUSED);
  // 用户点击「保留本地版本」
  await host.resolveKeepLocal();
  // 强制本地覆盖远端被调用
  const syncCalls = p._calls.filter((c) => c[0] === "sync");
  assert.deepEqual(syncCalls[syncCalls.length - 1].slice(1), [STRATEGY.LOCAL_OVER_REMOTE, true]);
  assert.equal(host.state, SyncState.RESOLVED, "解决后应进入 RESOLVED");
  assert.equal(host.conflictDetail, null, "冲突详情应清空");
  assert.ok(p._calls.some((c) => c[0] === "startAutoSync"), "应恢复自动同步定时器");
  assert.ok(!p.topBarElement.classList.classes.has("git-sync-conflict-paused"), "红色徽标应移除");
  assert.ok(p._data[DATA_FILE] && p._data[DATA_FILE].state === SyncState.IDLE, "持久化应复位");
});

test("用户选择「保留远端版本」: 强制远端覆盖本地", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  const host = p.__gSyncFlowHost;
  p.timerTask = { removeSelf() {} };
  await host.runSync(undefined, false);
  await host.resolveKeepRemote();
  const syncCalls = p._calls.filter((c) => c[0] === "sync");
  assert.deepEqual(syncCalls[syncCalls.length - 1].slice(1), [STRATEGY.REMOTE_OVER_LOCAL, true]);
  assert.equal(host.state, SyncState.RESOLVED);
});

test("解决冲突的同步再次失败: 回到 CONFLICT_PAUSED, 重新弹窗", async () => {
  let baseMode = "conflict";
  const p = makeFakePlugin({
    baseSync: async function (t, s) {
      p._calls.push(["sync", t, s]);
      if (baseMode === "conflict") {
        throw { name: "Mr", code: 300, path: "data/x.sy", message: "⚠文档冲突:" };
      }
      if (baseMode === "network") {
        throw { name: "Ht", code: 204, message: "网络错误" };
      }
      return {};
    },
  });
  const host = p.__gSyncFlowHost;
  p.timerTask = { removeSelf() {} };
  await host.runSync(undefined, false);
  assert.equal(host.state, SyncState.CONFLICT_PAUSED);
  baseMode = "network";
  await assert.rejects(
    () => host.resolveKeepLocal(),
    (e) => e && e.message === "网络错误"
  );
  assert.equal(host.state, SyncState.CONFLICT_PAUSED, "解决失败应回到暂停态");
  assert.ok(host.dialog, "应再次弹窗");
});

test("「正在同步中」保护错误不改变状态", async () => {
  const p = makeFakePlugin({
    baseSync: async function () {
      const e = new Error("正在同步中");
      throw e;
    },
  });
  const host = p.__gSyncFlowHost;
  host.state = SyncState.SUCCESS;
  await assert.rejects(() => host.runSync(undefined, false), /正在同步中/);
  assert.equal(host.state, SyncState.SUCCESS, "良性错误不应把状态改成 FAILED");
});

test("非冲突错误: 状态 FAILED 并重新抛出", async () => {
  const p = makeFakePlugin({
    baseSync: async function () {
      throw new Error("网络错误");
    },
  });
  const host = p.__gSyncFlowHost;
  await assert.rejects(() => host.runSync(undefined, false), /网络错误/);
  assert.equal(host.state, SyncState.FAILED);
  assert.ok(p._q._msgs.some((m) => m.type === "error" && /同步失败: 网络错误/.test(m.msg)));
  assert.ok(host.logEntries.some((entry) => entry.level === "error" && /网络错误/.test(entry.message)));
});

test("底层 Git API 错误: 前端显示 HTTP 状态和脱敏摘要", async () => {
  const p = makeFakePlugin({
    baseSync: async function () {
      throw {
        message: "创建文件提交树失败",
        cause: {
          status: 413,
          response: { status: 413, data: { message: "request entity too large" } },
          message: "上传失败",
          path: "conf/appearance/fonts/font.ttf",
        },
      };
    },
  });
  const host = p.__gSyncFlowHost;
  await assert.rejects(() => host.runSync(undefined, false));
  assert.ok(host.logEntries.some((entry) => /HTTP 413/.test(entry.message)));
  assert.ok(p._q._msgs.some((m) => /HTTP 413/.test(m.msg)));
});

test("持久化恢复: 重启后保持冲突暂停状态", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  const host = p.__gSyncFlowHost;
  p.timerTask = { removeSelf() {} };
  await host.runSync(undefined, false);
  assert.equal(host.state, SyncState.CONFLICT_PAUSED);
  // 模拟重启: 重新创建宿主并恢复
  const p2 = makeFakePlugin();
  const host2 = p2.__gSyncFlowHost;
  p2._data[DATA_FILE] = p._data[DATA_FILE]; // 复制持久化数据
  const restored = host2.onAfterLoad();
  assert.equal(typeof restored.then, "function", "恢复必须可等待，防止布局初始化抢跑");
  await restored;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(host2.state, SyncState.CONFLICT_PAUSED, "重启后应恢复暂停");
  assert.equal(host2.conflictDetail.path, "data/notebook/doc.sy");
});

test("稍后处理: 保持暂停, 弹窗关闭", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  const host = p.__gSyncFlowHost;
  p.timerTask = { removeSelf() {} };
  await host.runSync(undefined, false);
  const dialog = host.dialog;
  assert.ok(dialog);
  host.closeDialog();
  assert.equal(host.dialog, null);
  assert.equal(host.state, SyncState.CONFLICT_PAUSED);
});

test("手动同步模式: 解决后不恢复自动定时器", async () => {
  const p = makeFakePlugin({
    conflictOnSync: true,
    settings: { [SETTING.syncMode]: String(SYNC_MODE.MANUAL) },
  });
  const host = p.__gSyncFlowHost;
  p.timerTask = { removeSelf() {} };
  await host.runSync(undefined, false);
  await host.resolveKeepLocal();
  const starter = p._calls.filter((c) => c[0] === "startAutoSync");
  assert.equal(starter.length, 0, "手动模式不应恢复自动同步");
  assert.equal(host.state, SyncState.RESOLVED);
});

test("runSync 包装方法可被插件实例直接调用(模拟补丁后的 syncDataToCloud)", async () => {
  const p = makeFakePlugin();
  const ret = await p.syncDataToCloud(undefined, false);
  assert.equal(p.__gSyncFlowHost.state, SyncState.SUCCESS);
  assert.ok(ret);
});

/* ===================== M1: 同步结果即时可见 ===================== */

test("M1 事件总线: on/emit/off 基本行为", () => {
  const bus = createEventBus();
  const got = [];
  const fn = (p) => got.push(p);
  bus.on("sync:success", fn);
  bus.emit("sync:success", { x: 1 });
  bus.emit("sync:success", { x: 2 });
  assert.deepEqual(got, [{ x: 1 }, { x: 2 }]);
  bus.off("sync:success", fn);
  bus.emit("sync:success", { x: 3 });
  assert.deepEqual(got, [{ x: 1 }, { x: 2 }], "off 后不应再收到事件");
  // 订阅者异常不影响 emit
  bus.on("boom", () => { throw new Error("订阅者炸了"); });
  assert.doesNotThrow(() => bus.emit("boom", {}));
});

test("M1 classifyError: 冲突/认证/权限/仓库/分支/推送被拒/网络/未知 分类", () => {
  // 冲突(经 cause 链)
  const conflict = classifyError({ message: "outer", cause: { code: 300, path: "a.sy" } });
  assert.equal(conflict.category, "CONFLICT");
  assert.equal(conflict.retryable, false);
  assert.equal(conflict.recoverable, true);
  // 401 → AUTH, 不可重试
  const auth = classifyError({ status: 401, message: "unauthorized" });
  assert.equal(auth.category, "AUTH");
  assert.equal(auth.retryable, false);
  // 403 → PERMISSION
  assert.equal(classifyError({ status: 403 }).category, "PERMISSION");
  // 404 仓库不存在(无 branch 字样)
  assert.equal(classifyError({ status: 404, message: "repository not found" }).category, "REPOSITORY");
  // 404 含 branch → BRANCH
  assert.equal(classifyError({ status: 404, message: "branch main not found" }).category, "BRANCH");
  // 409 / 422 → PUSH_REJECTED, 可重试
  const push = classifyError({ status: 409, message: "non-fast-forward" });
  assert.equal(push.category, "PUSH_REJECTED");
  assert.equal(push.retryable, true);
  assert.equal(classifyError({ status: 422 }).category, "PUSH_REJECTED");
  // 413 → BLOB_LIMIT
  assert.equal(classifyError({ status: 413 }).category, "BLOB_LIMIT");
  // 网络特征 → NETWORK, 可重试
  const net = classifyError(new Error("socket hang up: ETIMEDOUT"));
  assert.equal(net.category, "NETWORK");
  assert.equal(net.retryable, true);
  const net2 = classifyError(new Error("连接超时"));
  assert.equal(net2.category, "NETWORK");
  // 未知 → UNKNOWN, 可重试(有限次数)
  const unk = classifyError(new Error("something weird"));
  assert.equal(unk.category, "UNKNOWN");
  assert.equal(unk.retryable, true);
  // status 从深层 cause 提取
  const deep = classifyError({ message: "m", cause: { message: "m2", cause: { status: 500 } } });
  assert.equal(deep.status, 500);
  assert.equal(deep.category, "GIT_API");
});

test("M1 getErrorSummary: 保留最外层 HTTP 状态 + 最底层消息 + 文件路径", () => {
  const p = makeFakePlugin({
    baseSync: async function () {
      throw {
        message: "外层消息",
        cause: {
          status: 500,
          message: "内层失败",
          path: "data/x.sy",
        },
      };
    },
  });
  const host = p.__gSyncFlowHost;
  return assert.rejects(() => host.runSync(undefined, false)).then(() => {
    assert.ok(host.logEntries.some((e) => /HTTP 500/.test(e.message)), "应保留最外层 HTTP 状态");
    assert.ok(host.logEntries.some((e) => /内层失败/.test(e.message)), "应保留最底层消息");
    assert.ok(host.logEntries.some((e) => /x\.sy/.test(e.message)), "应保留文件路径");
  });
});

test("M1 同步成功: SUCCESS + 开始/成功通知 + 事件 + 历史", async () => {
  const p = makeFakePlugin();
  const host = p.__gSyncFlowHost;
  const events = [];
  host.events.on("sync:start", (e) => events.push(["start", !!e.operationId]));
  host.events.on("sync:success", (e) => events.push(["success", !!e.operationId]));
  host.events.on("sync:history", (e) => events.push(["history", e.state]));
  const before = host.q._msgs.length;
  await host.runSync(undefined, false);
  // 手动触发: 开始 + 成功 两条 toast
  assert.ok(host.q._msgs.slice(before).some((m) => /开始同步/.test(m.msg)));
  assert.ok(host.q._msgs.slice(before).some((m) => m.type === "info" && /同步成功/.test(m.msg)));
  assert.ok(events.some((e) => e[0] === "start" && e[1]), "应发出 sync:start(带 operationId)");
  assert.ok(events.some((e) => e[0] === "success" && e[1]), "应发出 sync:success(带 operationId)");
  assert.equal(host.state, SyncState.SUCCESS);
  // 历史
  assert.equal(host.history.length, 1);
  assert.equal(host.history[0].state, SyncState.SUCCESS);
  assert.ok(events.some((e) => e[0] === "history" && e[1] === SyncState.SUCCESS));
  assert.ok(p._data[HISTORY_FILE] && Array.isArray(p._data[HISTORY_FILE].entries));
});

test("M1 自动定时触发: 不 toast「开始同步」, 成功结果仍通知", async () => {
  const p = makeFakePlugin();
  const host = p.__gSyncFlowHost;
  const before = host.q._msgs.length;
  host.markAutoTick();
  await host.runSync(undefined, false);
  const delta = host.q._msgs.slice(before);
  assert.equal(delta.filter((m) => /开始同步/.test(m.msg)).length, 0, "自动触发不应 toast「开始同步」(避免轰炸)");
  assert.ok(delta.some((m) => /同步成功/.test(m.msg)), "但同步结果(成功)仍需通知");
  assert.ok(host.logEntries.some((e) => /开始同步/.test(e.message)), "开始动作应写入运行日志");
});

test("M1 成功通知开关: sgsp_sync_notify=false 时不发成功 toast", async () => {
  const p = makeFakePlugin({ settings: { sgsp_sync_notify: false } });
  const host = p.__gSyncFlowHost;
  const before = host.q._msgs.length;
  await host.runSync(undefined, false);
  assert.equal(host.q._msgs.slice(before).filter((m) => /同步成功/.test(m.msg)).length, 0, "关闭后不应有成功 toast");
  assert.equal(host.state, SyncState.SUCCESS, "同步本身仍应成功");
});

test("M1 同步失败: FAILED + 分类 toast + 事件 + 历史(category)", async () => {
  const p = makeFakePlugin({
    baseSync: async function () {
      throw new Error("网络错误");
    },
  });
  const host = p.__gSyncFlowHost;
  const events = [];
  host.events.on("sync:error", (e) => events.push(e));
  await assert.rejects(() => host.runSync(undefined, false), /网络错误/);
  assert.equal(host.state, SyncState.FAILED);
  assert.ok(host.q._msgs.some((m) => m.type === "error" && /同步失败: 网络错误/.test(m.msg)), "失败 toast 含分类摘要");
  assert.ok(events.length >= 1 && events[0].category === "NETWORK", "sync:error 事件含分类");
  const entry = host.history[host.history.length - 1];
  assert.equal(entry.state, SyncState.FAILED);
  assert.equal(entry.category, "NETWORK");
});

test("M1 冲突: 事件 + 历史 + 数量通知 + 多冲突收集", async () => {
  // 一条链里两个冲突节点
  const p = makeFakePlugin({
    baseSync: async function () {
      throw {
        name: "Ht",
        code: 204,
        message: "同步失败",
        cause: {
          name: "Jt",
          code: -100,
          message: "任务出错",
          cause: {
            name: "Mr",
            code: 300,
            path: "data/a.sy",
            message: "冲突a",
            cause: { name: "Mr2", code: 300, path: "data/b.sy", message: "冲突b" },
          },
        },
      };
    },
  });
  const host = p.__gSyncFlowHost;
  const events = [];
  host.events.on("sync:conflict", (e) => events.push(e));
  await host.runSync(undefined, false);
  assert.equal(host.state, SyncState.CONFLICT_PAUSED);
  assert.equal(host.conflictDetail.conflictCount, 2, "应收集全部冲突节点");
  assert.equal(host.conflictDetail.conflicts.length, 2);
  assert.equal(host.conflictDetail.path, "data/a.sy", "path 保持第一个冲突");
  assert.ok(events.length === 1 && events[0].conflictCount === 2, "sync:conflict 事件含数量");
  assert.equal(host.history[host.history.length - 1].category, "CONFLICT");
  // 通知含数量
  assert.ok(host.q._msgs.some((m) => /2 个文件/.test(m.msg)));
  // 弹窗标题含数量
  assert.ok(host.dialog.opts.title.includes("2 个文件"));
});

test("M1 旧持久化数据迁移: 无 conflicts 字段 → 自动补全", async () => {
  const p = makeFakePlugin();
  const host = p.__gSyncFlowHost;
  // 模拟旧版本只保存了单文件字段
  p._data[DATA_FILE] = {
    state: SyncState.CONFLICT_PAUSED,
    conflictDetail: { path: "data/legacy.sy", message: "旧冲突", name: "Mr" },
    pausedSince: 111,
    pausedTimer: true,
  };
  await host.onAfterLoad();
  assert.equal(host.state, SyncState.CONFLICT_PAUSED);
  assert.equal(host.conflictDetail.conflictCount, 1, "旧数据迁移出 conflicts 数组");
  assert.equal(host.conflictDetail.path, "data/legacy.sy");
});

test("M1 历史环形上限 + 重启恢复", async () => {
  const p = makeFakePlugin();
  const host = p.__gSyncFlowHost;
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
    host.addHistoryEntry({ state: SyncState.SUCCESS, category: "", message: "m" + i });
  }
  assert.equal(host.history.length, HISTORY_LIMIT, "超过上限应裁剪到最近 N 条");
  // 持久化后重启恢复
  const p2 = makeFakePlugin();
  const host2 = p2.__gSyncFlowHost;
  p2._data[HISTORY_FILE] = p._data[HISTORY_FILE];
  await host2.onAfterLoad();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(host2.history.length, HISTORY_LIMIT);
  assert.equal(host2.history[host2.history.length - 1].message, "m" + (HISTORY_LIMIT + 9));
});

test("M1 持久化失败可观测: 保存状态失败 → 日志 + 通知, 不静默", async () => {
  const p = makeFakePlugin({ conflictOnSync: true });
  p.saveData = (name) => Promise.reject(new Error("磁盘满"));
  const host = p.__gSyncFlowHost;
  await host.runSync(undefined, false);
  assert.equal(host.state, SyncState.CONFLICT_PAUSED, "持久化失败不应阻断冲突暂停");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(host.logEntries.some((e) => /持久化失败/.test(e.message)), "应有持久化失败日志");
  assert.ok(host.q._msgs.some((m) => /保存失败/.test(m.msg)), "应有保存失败通知");
});

test("M1 脱敏: 错误消息中的 Bearer token / token 值被隐藏", async () => {
  const p = makeFakePlugin({
    baseSync: async function () {
      throw new Error("鉴权失败: Bearer abc123xyz token=secretvalue");
    },
  });
  const host = p.__gSyncFlowHost;
  await assert.rejects(() => host.runSync(undefined, false));
  const failMsg = host.logEntries
    .filter((e) => e.level === "error")
    .map((e) => e.message)
    .join("|");
  assert.ok(!/abc123xyz/.test(failMsg), "Bearer token 不应出现在日志");
  assert.ok(!/secretvalue/.test(failMsg), "token 值不应出现在日志");
  assert.ok(/Bearer \[已隐藏\]/.test(failMsg), "应显示脱敏占位");
});