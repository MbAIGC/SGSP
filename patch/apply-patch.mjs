#!/usr/bin/env node
/**
 * ============================================================================
 * SGSP —— 冲突处理闭环补丁/构建脚本
 * ============================================================================
 *
 * 仓库布局(根目录即插件包):
 *   vendor/index.js           官方 v0.3.0 原版 bundle(只读输入,永不修改)
 *   src/sync-flow-runtime.js  状态机 / 冲突闭环 / 通知 源码(单一事实来源)
 *   index.js                  构建产物:原版 bundle + 运行时注入(提交入库)
 *   index.css / i18n/ / plugin.json / icon.png / preview.png  插件包文件
 *
 * 作用: 把 src/sync-flow-runtime.js 注入 vendor/index.js 中,生成根目录 index.js;
 *       并幂等地补齐 index.css(冲突徽标样式)、i18n(界面文案)、
 *       plugin.json(版本号,默认 0.3.0-dev-00,可用环境变量 GIT_SYNC_VERSION 覆盖)。
 *
 * 注入点(全部为对原 bundle 的「前置/包装」修改,不改动任何同步算法):
 *   1. runtime 注入    —— 在 const q=require("siyuan"); 之后注入状态机宿主
 *   2. onload          —— 初始化宿主 + 恢复上次未解决的冲突暂停状态
 *   3. onLayoutReady   —— 顶栏徽标状态同步
 *   4. syncDataToCloud —— 原方法改名为 __gSyncDataToCloudBase,新增包装方法
 *                         (状态机入口 / 冲突拦截 / 暂停跳过 / 解决放行)
 *   5. startAutoSync   —— 给定时器回调打 autoTick 标记,区分「定时触发」与
 *                         「用户手动触发」
 *   6. i18n / index.css / plugin.json —— 补充界面文案、冲突徽标样式、版本号
 *
 * 用法: node patch/apply-patch.mjs            # 默认版本 0.3.0-dev-00
 *       GIT_SYNC_VERSION=0.3.0-dev-01 node patch/apply-patch.mjs
 *
 * 说明:
 *   - 输入永远从 vendor/index.js(官方原版)读取,重复执行结果一致(幂等);
 *   - i18n 只补缺失键、index.css 只追加一次徽标样式,均不覆盖手工调整;
 *   - 若 vendor/index.js 本身已含注入标记,脚本会报错,防止误把产物当输入。
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位仓库根目录。
 * 注意: 某些沙箱/容器环境下 import.meta.url 可能被解析到挂载别名路径,
 * 因此优先使用 process.cwd()(脚本约定从仓库根目录运行);
 * 若 cwd 不正确,再回退到脚本所在目录的父目录。
 */
function detectRoot() {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, ".."),
    __dirname,
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "vendor", "index.js"))) {
        return c;
      }
    } catch (e) {
      /* ignore */
    }
  }
  return process.cwd();
}
const ROOT = detectRoot();

const SRC_BUNDLE = path.join(ROOT, "vendor", "index.js"); // 官方原版 bundle(输入)
const SRC_RUNTIME = path.join(ROOT, "src", "sync-flow-runtime.js"); // 运行时源码(输入)
const OUT_INDEX_JS = path.join(ROOT, "index.js"); // 产物:根目录 index.js
const I18N_ZH = path.join(ROOT, "i18n", "zh_CN.json"); // 插件包语言文件(就地补齐)
const I18N_EN = path.join(ROOT, "i18n", "en_US.json");
const CSS_FILE = path.join(ROOT, "index.css"); // 插件包样式(就地追加)
const PLUGIN_JSON = path.join(ROOT, "plugin.json"); // 插件包元数据(就地写版本)

/** 默认版本号;可用环境变量 GIT_SYNC_VERSION 覆盖(CI 注入) */
const DEFAULT_VERSION = "0.3.1";
const VERSION = process.env.GIT_SYNC_VERSION || DEFAULT_VERSION;

const MARKER = "__gSyncFlow"; // 已注入标记

const I18N_KEYS_ZH = {
  gSyncConflictTitle: "⚠️ 检测到同步冲突",
  gSyncConflictDesc: "本地与远端的数据同时被修改,自动同步已暂停。请选择处理方式:",
  gSyncConflictFile: "冲突文件",
  gSyncKeepLocal: "保留本地版本",
  gSyncKeepRemote: "保留远端版本",
  gSyncOpenConflictDoc: "打开冲突文档",
  gSyncLater: "稍后处理",
  gSyncLaterMsg: "冲突仍待处理:自动同步保持暂停,请及时处理",
  gSyncPausedMsg: "⚠️ 同步冲突未解决,自动同步已暂停,请处理冲突",
  gSyncPausedTooltip: "【GIT 同步】冲突未解决,自动同步已暂停,请点击处理",
  gSyncRestoredPausedMsg:
    "检测到未解决的同步冲突,自动同步已暂停。请点击插件图标处理冲突",
  gSyncConflictMsg: "🔴 检测到同步冲突,自动同步已暂停",
  gSyncResolvedMsg: "✅ 冲突已处理,自动同步已恢复",
  gSyncResolveFailedMsg: "❌ 处理冲突的同步失败,冲突仍待处理",
  gSyncOpenDocHint:
    "冲突文档已生成在原文档旁(文件名含 _conflict_ 前缀),请在左侧文件树中打开查看",
  gSyncRuntimeLogsTitle: "SGSP 运行日志",
  gSyncHistoryError: "❌ 同步历史面板暂时无法打开,请稍后重试",
};

const I18N_KEYS_EN = {
  gSyncConflictTitle: "⚠️ Sync conflict detected",
  gSyncConflictDesc:
    "Local and remote data were both modified; auto sync has been paused. Choose how to proceed:",
  gSyncConflictFile: "Conflicted file",
  gSyncKeepLocal: "Keep local version",
  gSyncKeepRemote: "Keep remote version",
  gSyncOpenConflictDoc: "Open conflict doc",
  gSyncLater: "Later",
  gSyncLaterMsg: "Conflict still pending: auto sync stays paused, please handle it later.",
  gSyncPausedMsg: "⚠️ Sync conflict unresolved, auto sync paused. Please resolve it first.",
  gSyncPausedTooltip: "【GIT Sync】Conflict unresolved, auto sync paused. Click to handle.",
  gSyncRestoredPausedMsg:
    "An unresolved sync conflict was detected; auto sync is paused. Click the plugin icon to handle it.",
  gSyncConflictMsg: "🔴 Sync conflict detected, auto sync paused",
  gSyncResolvedMsg: "✅ Conflict resolved, auto sync resumed",
  gSyncResolveFailedMsg: "❌ Resolution sync failed, conflict still pending",
  gSyncOpenDocHint:
    "The conflict doc was created next to the original (name contains _conflict_ prefix). Open it in the file tree.",
  gSyncRuntimeLogsTitle: "SGSP runtime logs",
  gSyncHistoryError: "❌ The sync history panel is unavailable. Please try again later.",
};

const CSS_MARK = "git-sync-conflict-paused"; // 徽标样式是否已注入的标记
const CSS_APPEND = `

/* ===== GIT-SYNC 冲突暂停状态徽标(patch/apply-patch.mjs 注入) ===== */
.toolbar__item.git-sync-conflict-paused svg{color:#e53935!important;animation:gitSyncConflictBlink 1.1s ease-in-out infinite}
@keyframes gitSyncConflictBlink{0%,100%{opacity:1}50%{opacity:.25}}
`;

function fail(msg) {
  console.error("[apply-patch] ✗ " + msg);
  process.exit(1);
}

function ok(msg) {
  console.log("[apply-patch] ✓ " + msg);
}

function read(file, required) {
  if (!fs.existsSync(file)) {
    if (required) fail("缺少文件: " + file);
    return null;
  }
  return fs.readFileSync(file, "utf8");
}

function assertAnchor(source, anchor, label) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    fail("锚点不唯一(出现 " + count + " 次): " + label + "\n  " + anchor.slice(0, 120));
  }
}

/** 把 ESM 运行时转换成可注入的 IIFE 工厂代码 */
function embedRuntime() {
  let src = read(SRC_RUNTIME, true);
  // 剥离 ESM export 关键字
  src = src.replace(/^export\s+/gm, "");
  return (
    "// <<< GIT-SYNC conflict-flow runtime (injected by patch/apply-patch.mjs) >>>\n" +
    "var __gSyncHostFactory=(function(){\n" +
    src +
    "\nreturn {SyncState:SyncState,createSyncFlowHost:createSyncFlowHost,isConflictError:isConflictError};\n})();\n" +
    "var __gSyncFlow=null;\n" +
    "function __gEnsureSyncFlow(self){if(!__gSyncFlow){__gSyncFlow=__gSyncHostFactory.createSyncFlowHost(self,q);}return __gSyncFlow;}\n" +
    // 注意: 结尾必须是换行符,否则 // 注释会吞掉后续同行的原始代码
    "// <<< END GIT-SYNC conflict-flow runtime >>>\n"
  );
}

function patchIndex(js) {
  if (js.indexOf(MARKER) >= 0) {
    fail("vendor/index.js 已包含注入标记,请从官方 Release 重新获取原版 bundle,避免二次注入");
  }

  // 运行产物使用 SGSP 自身目录，避免把插件配置和凭据同步到远端。
  js = js
    .replaceAll("data/plugins/GIT-SYNC-PLUGIN/*", "data/plugins/SGSP/*")
    .replaceAll("data/storage/petal/GIT-SYNC-PLUGIN/*", "data/storage/petal/SGSP/*")
    .replaceAll("temp/GIT-SYNC-PLUGIN/backup/", "temp/SGSP/backup/");

  /* ---------- 1. 注入运行时 ---------- */
  const anchorSdk = 'const q=require("siyuan");';
  assertAnchor(js, anchorSdk, "siyuan SDK require");
  const runtime = embedRuntime();
  js = js.replace(anchorSdk, anchorSdk + "\n" + runtime);

  /* ---------- 2. onload 钩子 ---------- */
  const anchorOnload =
    'async onload(){S.info("onload");try{br.getInstance()}catch{br.getInstance()}await Za(this.i18n),await this.initPluginConfigData()}';
  assertAnchor(js, anchorOnload, "onload");
  js = js.replace(
    anchorOnload,
    'async onload(){S.info("onload");__gEnsureSyncFlow(this),__gSyncFlow&&await __gSyncFlow.onAfterLoad();try{br.getInstance()}catch{br.getInstance()}await Za(this.i18n),await this.initPluginConfigData()}'
  );

  /* ---------- 3. onLayoutReady 徽标 ---------- */
  const anchorLayout =
    'async onLayoutReady(){S.info("onLayoutReady"),await this.registerPluginButton(),await this.initPluginLayoutData()}';
  assertAnchor(js, anchorLayout, "onLayoutReady");
  js = js.replace(
    anchorLayout,
    'async onLayoutReady(){S.info("onLayoutReady"),__gSyncFlow&&__gSyncFlow.attachBadge(),await this.registerPluginButton(),await this.initPluginLayoutData()}'
  );

  /* ---------- 4. 运行日志菜单入口 ---------- */
  const historyMenuAnchor = 's.addItem({icon:"iconHistory",label:this.i18n.syncHistory,click:()=>{this.openSyncHistoryPanel()}})';
  assertAnchor(js, historyMenuAnchor, "同步历史菜单");
  const logsMenuItem = 's.addItem({icon:"iconInfo",label:this.i18n.gSyncRuntimeLogsTitle||"SGSP 运行日志",click:()=>{const host=__gSyncFlow||__gEnsureSyncFlow(this);host.showRuntimeLogs()}}),';
  js = js.replace(historyMenuAnchor, logsMenuItem + historyMenuAnchor);

  /* ---------- 5. syncDataToCloud 改名 + 包装 ---------- */
  const startM = "async syncDataToCloud(t=void 0,s=!1){";
  const endAnchor = "async registerPluginButton(){";
  assertAnchor(js, startM, "syncDataToCloud 方法开头");
  assertAnchor(js, endAnchor, "registerPluginButton 方法开头");
  const si = js.indexOf(startM);
  const ei = js.indexOf(endAnchor, si);
  const body = js.slice(si, ei); // 以 "}" 结尾
  if (!body.endsWith("}")) fail("syncDataToCloud 方法体解析异常(未以 } 结尾)");
  const inner = body.slice(startM.length, body.length - 1);
  const baseMethod =
    "async __gSyncDataToCloudBase(t=void 0,s=!1){" + inner + "}";
  const wrapperMethod =
    "async syncDataToCloud(t=void 0,s=!1){return (__gSyncFlow||(__gEnsureSyncFlow(this),__gSyncFlow)).runSync(t,s)}";
  js = js.slice(0, si) + baseMethod + "\n" + wrapperMethod + js.slice(ei);

  /* ---------- 5. startAutoSync 打 autoTick 标记 ---------- */
  const anchorTimer =
    'async startAutoSync(t,s,i="every",...o){this.timerTask&&this.timerTask.removeSelf(),s||(s=this.settingUtils.get(je)),s=s*1e3,i=="every"?this.timerTask=new Vi(t,s,o):i=="once"&&(this.timerTask=new Wi(t,s,o)),this.timerTask.start()}';
  assertAnchor(js, anchorTimer, "startAutoSync");
  js = js.replace(
    anchorTimer,
    'async startAutoSync(t,s,i="every",...o){if(__gSyncFlow&&__gSyncFlow.isPausedConflict())return;let __cb=t;if(__gSyncFlow&&__cb){const __raw=__cb;__cb=function(){__gSyncFlow.markAutoTick(),__raw.apply(this,arguments)}}this.timerTask&&this.timerTask.removeSelf(),s||(s=this.settingUtils.get(je)),s=s*1e3,i=="every"?this.timerTask=new Vi(__cb,s,o):i=="once"&&(this.timerTask=new Wi(__cb,s,o)),this.timerTask.start()}'
  );

  /* ---------- 6. 同步历史面板挂载保护 ---------- */
  const historyStart = "async openSyncHistoryPanel(){";
  const historyEnd = "async openPayMentPlanPanel(){";
  assertAnchor(js, historyStart, "openSyncHistoryPanel 方法开头");
  assertAnchor(js, historyEnd, "openPayMentPlanPanel 方法开头");
  const hi = js.indexOf(historyStart);
  const he = js.indexOf(historyEnd, hi);
  const historyBody = js.slice(hi, he);
  if (!historyBody.endsWith("}")) fail("openSyncHistoryPanel 方法体解析异常(未以 } 结尾)");
  let historyInner = historyBody.slice(historyStart.length, historyBody.length - 1);
  const historyGuard =
    '});if(!t.element||!t.element.querySelector||!t.element.querySelector("#syncHistory")){const host=__gSyncFlow||__gEnsureSyncFlow(this);host.addLog("error","同步历史面板挂载节点不存在");host.notify(host.i18n("gSyncHistoryError","❌ 同步历史面板暂时无法打开,请稍后重试"),"error");return}let s=new Qc';
  if (!historyInner.includes("}),s=new Qc")) fail("openSyncHistoryPanel 挂载点锚点不存在");
  historyInner = historyInner.replace("}),s=new Qc", historyGuard);
  const historyMethod =
    "async openSyncHistoryPanel(){try{" + historyInner + "}catch(err){const host=__gSyncFlow||__gEnsureSyncFlow(this);host.addLog(\"error\",\"同步历史面板打开失败: \"+(err&&err.message?err.message:err));host.notify(host.i18n(\"gSyncHistoryError\",\"❌ 同步历史面板暂时无法打开,请稍后重试\"),\"error\");}}";
  js = js.slice(0, hi) + historyMethod + js.slice(he);

  /* ---------- 7. gitUtil 错误向状态机传播 ---------- */
  const anchorsGitUtil = [
    'He([we({rethrow:!1})],xe.prototype,"handleRemoteCoverLocal")',
    'He([we({rethrow:!1})],xe.prototype,"handleLocalCoverRemote")',
    'He([we({rethrow:!1})],xe.prototype,"handleAutoRemoteAndLocalFileSync")',
  ];
  for (const anchor of anchorsGitUtil) {
    assertAnchor(js, anchor, "gitUtil 同步错误传播");
    js = js.replace(anchor, anchor.replace("rethrow:!1", "rethrow:!0"));
  }

  // 语法校验(写入前)
  const check = path.join(ROOT, "index.js");
  fs.writeFileSync(check, js);
  const r = spawnSync(process.execPath, ["--check", check], { encoding: "utf8" });
  fs.rmSync(check, { force: true });
  if (r.status !== 0) {
    fail("注入后语法错误:\n" + r.stderr);
  }
  return js;
}

/** 就地补齐 i18n: 只加缺失键,不覆盖已有(幂等) */
function patchJson(file, keys) {
  const raw = read(file, true);
  const data = JSON.parse(raw);
  let changed = 0;
  for (const k of Object.keys(keys)) {
    if (data[k] === undefined) {
      data[k] = keys[k];
      changed++;
    }
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 4) + "\n");
  return changed;
}

/** 就地追加冲突徽标样式(幂等) */
function patchCss() {
  const css = read(CSS_FILE, true);
  if (css.indexOf(CSS_MARK) >= 0) return false;
  fs.writeFileSync(CSS_FILE, css + CSS_APPEND);
  return true;
}

/** 就地写入版本号(默认 0.3.0-dev-00,可用 GIT_SYNC_VERSION 覆盖) */
function patchVersion() {
  const raw = read(PLUGIN_JSON, true);
  const data = JSON.parse(raw);
  const old = data.version;
  data.version = VERSION;
  fs.writeFileSync(PLUGIN_JSON, JSON.stringify(data, null, 2) + "\n");
  return { old, now: data.version };
}

function main() {
  const js = read(SRC_BUNDLE, true);
  const patched = patchIndex(js);

  const zh = patchJson(I18N_ZH, I18N_KEYS_ZH);
  const en = patchJson(I18N_EN, I18N_KEYS_EN);
  const cssChanged = patchCss();
  const ver = patchVersion();

  // 最终产物写回根目录(根目录即插件包)
  fs.writeFileSync(path.join(ROOT, "index.js"), patched);

  ok("index.js 已生成(由 vendor/index.js + src/sync-flow-runtime.js 注入)");
  ok("i18n 已补齐(" + (zh + en) + " 个键,zh=" + zh + " en=" + en + ")");
  ok(cssChanged ? "index.css 已追加冲突徽标样式" : "index.css 徽标样式已存在,跳过");
  ok("plugin.json 版本号 " + ver.old + " → " + ver.now);
  console.log("\n[apply-patch] 完成。根目录即为可安装的插件包(复制到 data/plugins/SGSP/)。");
}

main();