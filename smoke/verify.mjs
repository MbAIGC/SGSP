/**
 * 端到端冒烟验证: 用 siyuan stub 加载根目录插件包(即构建产物 index.js),
 * 模拟一次完整冲突闭环:
 *   自动同步 → 冲突 → 暂停定时器 → 弹窗/徽标/通知 → 暂停会话内再触发(拦截)
 *   → 用户选择「保留远端版本」→ 强制远端覆盖 → resolved → 恢复通知
 *
 * 运行: node smoke/verify.mjs
 * 依赖: 已执行 node patch/apply-patch.mjs 生成根目录 index.js
 */

import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BUNDLE = path.join(ROOT, "index.js");
const PLUGIN_JSON = path.join(ROOT, "plugin.json");
const I18N_ZH = path.join(ROOT, "i18n", "zh_CN.json");

if (!fs.existsSync(BUNDLE)) {
  console.error("未找到根目录 index.js,请先运行: node patch/apply-patch.mjs");
  process.exit(1);
}

// 让 bundle 内的 require("siyuan") 指向 stub
const STUB = path.join(ROOT, "smoke", "stub", "siyuan.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "siyuan") return STUB;
  return origResolve.call(this, request, ...args);
};

const siyuan = (await import(pathToFileURL(STUB).href)).default;
const msgs = [];
const dialogs = [];
siyuan.showMessage = (m, t, type) => msgs.push({ m, t, type });
siyuan.Dialog = class {
  constructor(opts) {
    this.opts = opts;
    this.element = { querySelector() { return { addEventListener() {} }; } };
    dialogs.push(opts);
  }
  destroy() { this.destroyed = true; }
};

const bundle = await import(pathToFileURL(BUNDLE).href);
const Cls = bundle.default || bundle;

const p = new Cls();
p.i18n = JSON.parse(fs.readFileSync(I18N_ZH, "utf8"));
const pluginMeta = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf8"));

let timerRemoved = false;
p.timerTask = { removeSelf() { timerRemoved = true; } };

function mkClassList() {
  const s = new Set();
  return {
    classes: s,
    add(c) { s.add(c); },
    remove(c) { s.delete(c); },
    toggle(c) { s.has(c) ? s.delete(c) : s.add(c); return s.has(c); },
  };
}
const svgFake = { classList: mkClassList(), setAttribute() {} };
p.topBarElement = { classList: mkClassList(), title: "", querySelector() { return svgFake; } };
p.settingUtils = {
  get(k) {
    const m = { enabled_sync: true, sync_strategy: 0, sync_mode: "0", sync_interval: 600000 };
    return m[k];
  },
};
p.gitUtil = {
  async handleAutoRemoteAndLocalFileSync() {
    const conflictErr = { name: "Mr", code: 300, path: "data/20210808180117-czj9bvb/note.sy", message: "⚠文档冲突:" };
    throw { name: "Jt", code: -100, message: "runLocalSyncTask", cause: conflictErr };
  },
};
p.startAutoSync = function () {};

let failures = 0;
function check(label, cond) {
  console.log((cond ? "✔ " : "✘ ") + label);
  if (!cond) failures++;
}

await p.syncDataToCloud();
const host = p.__gSyncFlowHost;

check("插件标识 = SGSP", pluginMeta.name === "SGSP" && p.name === "SGSP");
check("状态 = conflict_paused", host.state === "conflict_paused");
check("自动同步定时器已暂停", timerRemoved === true);
check("冲突详情已提取", host.conflictDetail && host.conflictDetail.path === "data/20210808180117-czj9bvb/note.sy");
check("弹出冲突对话框(含标题)", dialogs.length >= 1 && /冲突/.test(dialogs[0].title));
check("顶栏红色徽标", p.topBarElement.classList.classes.has("git-sync-conflict-paused"));
check("已发出错误级通知", msgs.some((m) => m.type === "error"));

// 暂停会话内,自动定时器再触发: 应被拦截,只提示一次
host.markAutoTick();
const before = msgs.length;
await p.syncDataToCloud();
check("暂停后自动触发被拦截(状态不变)", host.state === "conflict_paused");
check("暂停后提示只出现一次", msgs.length - before === 1);

// 用户选择「保留远端版本」
let remoteCoverCalled = false;
p.gitUtil.handleRemoteCoverLocal = async function (force) { remoteCoverCalled = force === true; return {}; };
p.gitUtil.handleLocalCoverRemote = async function () { return {}; };
await host.resolveKeepRemote();
check("强制远端覆盖被调用(force=true)", remoteCoverCalled === true);
check("解决后状态 = resolved", host.state === "resolved");
check("红色徽标已移除", !p.topBarElement.classList.classes.has("git-sync-conflict-paused"));
check("发出恢复通知", msgs.some((m) => String(m.m).includes("冲突已处理")));

// 构建产物必须保留原同步入口的异常传播，否则状态机无法接管冲突。
const builtSource = fs.readFileSync(BUNDLE, "utf8");
check(
  "构建产物传播三个同步入口异常",
  (builtSource.match(/He\(\[we\(\{rethrow:!0\}\)\],xe\.prototype,"handle(RemoteCoverLocal|LocalCoverRemote|AutoRemoteAndLocalFileSync)"\)/g) || []).length === 3
);

Module._resolveFilename = origResolve;

console.log(failures === 0 ? "\n端到端冒烟验证全部通过 ✔" : `\n存在 ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);