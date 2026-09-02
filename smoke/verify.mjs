#!/usr/bin/env node
/**
 * 冒烟验证: 以存根 siyuan 模块装载构建产物 index.js,
 * 模拟思源插件生命周期,验证入口可加载、事件挂接与引擎装配链路完整。
 * 不访问任何真实网络。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(["✅", name, ""]);
  } catch (err) {
    results.push(["❌", name, (err && err.message) || String(err)]);
  }
}

// ---------- siyuan 存根 ----------
const stubCalls = { addTopBar: 0, showMessage: 0, dialog: 0, settingOpen: 0 };
class StubPlugin {
  constructor() {
    this.data = {};
    this.i18n = {};
  }
  addIcons() {}
  addTopBar(opts) {
    stubCalls.addTopBar += 1;
    if (opts && typeof opts.callback === "function") this._topBarCb = opts.callback;
  }
  async loadData(name) {
    return this.data[name] === undefined ? null : JSON.parse(JSON.stringify(this.data[name]));
  }
  async saveData(name, payload) {
    this.data[name] = JSON.parse(JSON.stringify(payload));
    return true;
  }
}
class StubSetting {
  constructor(opts) {
    this.opts = opts;
    this.items = [];
  }
  addItem(item) {
    this.items.push(item);
  }
  open() {
    stubCalls.settingOpen += 1;
  }
}
class StubDialog {
  constructor(opts) {
    stubCalls.dialog += 1;
    this.opts = opts;
    this.element = {
      querySelector: () => ({ textContent: "", appendChild: () => {} }),
    };
  }
  destroy() {}
}
class StubMenu {
  constructor() {
    this.items = [];
  }
  addItem(item) {
    this.items.push(item);
    return this;
  }
  addSeparator() {
    return this;
  }
  open() {}
}
const siyuanStub = {
  Plugin: StubPlugin,
  Setting: StubSetting,
  Dialog: StubDialog,
  Menu: StubMenu,
  showMessage: () => {
    stubCalls.showMessage += 1;
  },
  confirm: () => {},
  getFrontend: () => "desktop",
  addTopBar: StubPlugin.prototype.addTopBar,
  fetchSyncPost: async (api) => {
    // 内核目录枚举存根: 一个本地文档,驱动引擎走完整规划/推送链路
    if (api === "/api/file/readDir") {
      return { code: 0, data: { dir: [], file: [{ name: "a.md", isDir: false, updated: Math.floor(Date.now() / 1000) }] } };
    }
    return { code: 0, data: {} };
  },
  openTab: () => {},
};

// ---------- 模块装载钩子 ----------
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "siyuan") return "siyuan-stub";
  return origResolve.call(this, request, ...rest);
};
require.cache["siyuan-stub"] = { id: "siyuan-stub", filename: "siyuan-stub", loaded: true, exports: siyuanStub };

// ---------- 最小 DOM / fetch 存根(设置面板与顶栏需要) ----------
function fakeEl() {
  return {
    style: {},
    dataset: {},
    className: "",
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) {
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ right: 0, bottom: 0 }),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    textContent: "",
    placeholder: "",
    disabled: false,
    checked: false,
    value: "",
    type: "",
    focus() {},
  };
}
globalThis.document = {
  createElement: () => fakeEl(),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  body: fakeEl(),
};
globalThis.window = { innerWidth: 1200, addEventListener() {} };
globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  statusText: "Not Found",
  headers: { get: () => "" },
  json: async () => ({ message: "Not Found" }),
  text: async () => "Not Found",
  arrayBuffer: async () => new ArrayBuffer(0),
});

// ---------- 装载构建产物 ----------
const distPath = path.join(__dirname, "..", "index.js");
check("构建产物存在", () => {
  if (!fs.existsSync(distPath)) throw new Error("index.js 不存在,请先执行 npm run build");
  const code = fs.readFileSync(distPath, "utf8");
  if (!code.includes("module.exports = module.exports.default")) throw new Error("缺少 CJS default 导出修复");
});

const SyGspPlugin = require(distPath);
check("入口导出插件类", () => {
  if (typeof SyGspPlugin !== "function") throw new Error("index.js 未导出插件类");
  if (!(SyGspPlugin.prototype instanceof StubPlugin)) throw new Error("插件类未继承 siyuan.Plugin");
});

// ---------- 生命周期冒烟 ----------
const plugin = new SyGspPlugin();
plugin.i18n = require(path.join(__dirname, "..", "i18n/zh_CN.json"));
plugin.data = {
  "settings.json": {
    repository_address: "https://github.com/o/r.git",
    repository_branch: "main",
    submit_token: "tk",
  },
  "engine-state.json": { firstWriteConfirmed: true },
}; // saveData/loadData 存根存储(onload 前预置配置)

(async () => {
  await plugin.onload();
  check("onload: 内核/存储/控制器装配", () => {
    if (!plugin.kernel) throw new Error("kernel 未装配");
    if (!plugin.metadataStore) throw new Error("metadataStore 未装配");
    if (!plugin.controller) throw new Error("controller 未装配");
    if (!plugin.settingUtils || plugin.settingUtils.settings.size < 15) throw new Error("设置项装配不完整");
  });

  await plugin.onLayoutReady();
  check("onLayoutReady: 顶栏注册", () => {
    if (stubCalls.addTopBar < 1) throw new Error("addTopBar 未调用");
  });

  // 路径一: 配置缺失(临时清空) → 提示并打开设置,不触发引擎
  const savedAddr = plugin.settingUtils.take("repository_address");
  const savedBranch = plugin.settingUtils.take("repository_branch");
  const savedToken = plugin.settingUtils.take("submit_token");
  plugin.settingUtils.set("repository_address", "");
  plugin.settingUtils.set("submit_token", "");
  await plugin.syncNow({ trigger: "manual" });
  check("syncNow: 配置缺失安全返回", () => {
    if (stubCalls.showMessage < 1) throw new Error("未提示配置缺失");
    if (stubCalls.settingOpen < 1) throw new Error("未打开设置面板");
  });
  plugin.settingUtils.set("repository_address", savedAddr);
  plugin.settingUtils.set("repository_branch", savedBranch);
  plugin.settingUtils.set("submit_token", savedToken);

  // 路径二: 配置齐全 + 远端不可达(404) → 引擎报错且错误已分类,不伪造成功
  let engineError = null;
  try {
    await plugin.syncNow({ trigger: "manual" });
  } catch (err) {
    engineError = err;
  }
  check("syncNow: 引擎链路执行且错误可分类", () => {
    if (!engineError) throw new Error("假远端应报错,却返回成功(伪造成功路径)");
    if (!engineError.category) throw new Error("错误缺少分类");
  });

  await plugin.onunload();
  check("onunload: 清理定时器与控制器", () => {
    if (plugin.timerTask !== null) throw new Error("自动同步定时器未清理");
  });

  // 汇总
  let failed = 0;
  for (const [icon, name, msg] of results) {
    if (icon === "❌") failed += 1;
    console.log(icon + " " + name + (msg ? " — " + msg : ""));
  }
  if (failed > 0) {
    console.log("\n冒烟验证失败: " + failed + " 项");
    process.exit(1);
  }
  console.log("\n冒烟验证全部通过(" + results.length + " 项)");
})().catch((err) => {
  console.error("冒烟验证异常终止:", err);
  process.exit(1);
});
