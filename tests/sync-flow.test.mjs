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
  DATA_FILE,
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