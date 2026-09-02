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
 *       plugin.json(版本号,默认 0.3.01,可用环境变量 GIT_SYNC_VERSION 覆盖)。
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
 * 用法: node patch/apply-patch.mjs            # 默认版本 0.3.01
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
const DEFAULT_VERSION = "0.4.0";
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
  gSyncStartMsg: "🔄 开始同步...",
  gSyncSuccessMsg: "✅ 同步成功",
  gSyncCreatedLabel: "新增",
  gSyncUpdatedLabel: "更新",
  gSyncDeletedLabel: "删除",
  gSyncFilesDetailLabel: "本次同步文件",
  gSyncNoChangeMsg: "未检测到文件变更,已停止同步",
  gSyncPersistFailed: "⚠️ 状态保存失败,重启后可能丢失暂停状态",
  gSyncHistorySaveFailed: "⚠️ 同步历史保存失败",
  sgspSyncNotifyTitle: "成功时通知",
  sgspSyncNotifyDesc: "每次同步成功时显示通知(默认开启,关闭后仅失败与冲突仍会通知)",
  sgspAutoRetryTitle: "自动重试",
  sgspAutoRetryDesc: "同步失败且可重试时自动重试(默认关闭,将在后续版本启用)",
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
  gSyncStartMsg: "🔄 Syncing...",
  gSyncSuccessMsg: "✅ Sync succeeded",
  gSyncCreatedLabel: "created",
  gSyncUpdatedLabel: "updated",
  gSyncDeletedLabel: "deleted",
  gSyncFilesDetailLabel: "Files synced",
  gSyncNoChangeMsg: "No file changes detected; sync stopped",
  gSyncPersistFailed: "⚠️ State save failed, paused state may be lost after restart",
  gSyncHistorySaveFailed: "⚠️ Sync history save failed",
  sgspSyncNotifyTitle: "Notify on success",
  sgspSyncNotifyDesc: "Show a notification after each successful sync (default on; when off, failures and conflicts are still notified)",
  sgspAutoRetryTitle: "Auto retry",
  sgspAutoRetryDesc: "Automatically retry retryable sync failures (default off; will be enabled in a later version)",
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

  /* ---------- 7. Git Blob 上传诊断与请求大小预检 ---------- */
  const blobStart = "async addFileToWorkArea(";
  const blobEnd = "async commitAndPushFileToRemote(";
  const blobCandidates = [];
  let blobCursor = 0;
  while ((blobCursor = js.indexOf(blobStart, blobCursor)) >= 0) {
    blobCandidates.push(blobCursor);
    blobCursor += blobStart.length;
  }
  if (blobCandidates.length !== 2) fail("addFileToWorkArea 方法数量异常: " + blobCandidates.length);
  const bi = blobCandidates.find((pos) => {
    const end = js.indexOf(blobEnd, pos);
    return end > pos && js.slice(pos, end).includes("rest.git.createBlob");
  });
  if (bi === undefined) fail("未找到包含 Git Blob 上传调用的 addFileToWorkArea 方法");
  const be = js.indexOf(blobEnd, bi);
  if (be < 0) fail("commitAndPushFileToRemote 方法边界不存在");
  const blobBody = js.slice(bi, be);
  if (!blobBody.endsWith("}")) fail("addFileToWorkArea 方法体解析异常(未以 } 结尾)");
  const blobInner = blobBody.slice(blobStart.length, blobBody.length - 1);
  const blobNeedle = "let n;try{if(n=await this.octokit.rest.git.createBlob({owner:this.owner,repo:this.repo,content:Yr.Buffer.from(s.content).toString(s.encoding),encoding:s.encoding}),S.info(\"createBlob:\",n),n.status==201||n.status==200)";
  assertAnchor(blobInner, blobNeedle, "Git Blob 上传调用");
  const blobReplacement =
    'let n;const __rawSize=Number(s.size)||0,__encodedSize=Math.ceil(__rawSize/3)*4,__requestSize=__encodedSize+2048,__limit=Number(this.settingUtils.get("sgsp_blob_request_limit"))||33554432;if(__requestSize>__limit)throw new Jt(Ge.LIMITED,`${s.path} ${this.i18n.fileSizeOver} ${Math.round(__requestSize/1048576)}MB`);try{if(n=await this.octokit.rest.git.createBlob({owner:this.owner,repo:this.repo,content:Yr.Buffer.from(s.content).toString(s.encoding),encoding:s.encoding}),S.info("createBlob:",n),n.status==201||n.status==200)';
  const blobPatchedBody = blobBody.replace(blobNeedle, blobReplacement).replace(
    "}catch{throw new Fe(ne.GIT_BLOB,s.path,this.i18n.createFileTreeFailed,s,n)}}}",
    "}catch(err){const __wrapped=new Fe(ne.GIT_BLOB,s.path,this.i18n.createFileTreeFailed,s,n);__wrapped.cause=err;throw __wrapped}}}"
  );
  assertAnchor(blobPatchedBody, "catch(err){const __wrapped=new Fe(ne.GIT_BLOB", "Git Blob 底层错误保留");
  js = js.slice(0, bi) + blobPatchedBody + js.slice(be);

  /* ---------- 7.1 文件操作统计: addFileToWorkArea 入口注入 trackFile ---------- */
  // 两个 addFileToWorkArea 方法都会记录 {operate, path},供运行时在成功日志中汇总本次同步的文件
  const trackAnchor = "async addFileToWorkArea(t,s,i){";
  const trackCount = js.split(trackAnchor).length - 1;
  if (trackCount !== 2) fail("addFileToWorkArea 注入锚点数量异常: " + trackCount);
  const trackInject =
    'try{__gSyncFlow&&__gSyncFlow.trackFile(i,s&&s.path?s.path:"")}catch(e){}';
  js = js.split(trackAnchor).join(trackAnchor + trackInject);

  /* ---------- 7.2 P0 数据完整性: readFileBlob markdown 导出空内容防护 ---------- */
  // markdown 模式下内容来自 /api/export/exportMdContent,导出失败(返回 null)
  // 或内容为空时,不得静默生成 0 字节 Blob(会造成远端 .sy/.md 为空)。
  // 改为抛出 Fe(GIT_BLOB) → 整次同步失败、不创建空 Blob。
  const mdAnchor = 'n=await nl(o);const a=/^---\\s*\\n([\\s\\S]*?)\\n---\\s*/;n.content=n.content.replace(a,""),s=new Blob([n.content])}else s=await Ms(e)';
  assertAnchor(js, mdAnchor, "readFileBlob markdown 导出");
  const mdInject =
    'n=await nl(o);if(!n||!n.content||String(n.content).length===0){try{__gSyncFlow&&__gSyncFlow.addLog("error","数据完整性异常: 导出 Markdown 内容为空,已停止同步 -> "+e)}catch(_e){}throw new Fe(ne.GIT_BLOB,e,"数据完整性异常: 导出 Markdown 内容为空,已停止同步")}const a=/^---\\s*\\n([\\s\\S]*?)\\n---\\s*/;n.content=n.content.replace(a,""),s=new Blob([n.content])}else s=await Ms(e)';
  js = js.replace(mdAnchor, mdInject);

  /* ---------- 7.3 P0 数据安全: al() 目录枚举异常标记 ---------- */
  // al() 的 catch 目前返回 {isExist:!1},会把「读目录失败」当成「文件不存在」,
  // 进而可能生成远端删除。注入枚举异常标记,删除安全判定据此拒绝删除。
  const alAnchor = '}catch(e){return S.error(`Workspace content read error-existsFileOrDir: ${e}`),{isExist:!1}}}';
  assertAnchor(js, alAnchor, "al() catch");
  const alInject =
    '}catch(e){try{__gSyncFlow&&__gSyncFlow.noteEnumError(r)}catch(_e){}return S.error(`Workspace content read error-existsFileOrDir: ${e}`),{isExist:!1}}}';
  js = js.replace(alAnchor, alInject);

  /* ---------- 7.4 P0 数据安全: addFileToWorkArea 删除安全判定 + 空内容防护 ---------- */
  // 删除操作统一在这里拦截:「本地不存在 ≠ 本地删除」。
  // 只有本地文件清单中存在该路径(证明本地曾经拥有)且属于当前同步范围,
  // 且本次同步没有发生目录枚举异常时,才允许生成远端删除。
  // vendor 中该函数有两个实现(第一版 i=="delete" 直接入 workTrees;
  // 第二版 i=="delete"||i=="update" 走内容上传路径),分别拦截。
  const del1Anchor = '}if(S.info("addFileToWorkArea:",t.size,s,"operate:",i),i=="delete"){';
  const del1Count = js.split(del1Anchor).length - 1;
  if (del1Count !== 1) fail("addFileToWorkArea 版本1 删除分支锚点数量异常: " + del1Count);
  const del1Inject =
    '}if(S.info("addFileToWorkArea:",t.size,s,"operate:",i),i=="delete"){try{const __p0a=s&&s.path?s.path:"";if(__gSyncFlow){const __g=__gSyncFlow.guardLocalDelete(__p0a);if(!__g.allow){__gSyncFlow.addLog("warn","⚠️ 跳过远端删除(无法确认本地删除): "+__p0a+" ("+__g.reason+")");return t}}}catch(_e){}';
  js = js.split(del1Anchor).join(del1Inject);

  const del2Anchor = '}else if(i=="delete"||i=="update"){let o=s.size;';
  const del2Count = js.split(del2Anchor).length - 1;
  if (del2Count !== 1) fail("addFileToWorkArea 版本2 删除分支锚点数量异常: " + del2Count);
  const del2Inject =
    '}else if(i=="delete"||i=="update"){try{const __p0b=s&&s.path?s.path:"";if(i=="delete"&&__gSyncFlow){const __g2=__gSyncFlow.guardLocalDelete(__p0b);if(!__g2.allow){__gSyncFlow.addLog("warn","⚠️ 跳过远端删除(无法确认本地删除): "+__p0b+" ("+__g2.reason+")");return t}}}catch(_e){}let o=s.size;';
  js = js.split(del2Anchor).join(del2Inject);

  // create/update: 上传前内容完整性防护(源文件非空时禁止生成空 Blob)
  // 两个实现的 size 上限常量不同(xi=41943040 / La),分别注入。
  const up1Anchor = 'if(o>=xi)throw new Jt(Ge.LIMITED,`${s.path} ${this.i18n.fileSizeOver} ${xi}MB`);';
  const up1Count = js.split(up1Anchor).length - 1;
  if (up1Count !== 1) fail("addFileToWorkArea 版本1 大小校验锚点数量异常: " + up1Count);
  const up1Inject =
    'try{if(__gSyncFlow&&!__gSyncFlow.contentIntegrityCheck(s.path,s.size,s.content))throw new Fe(ne.GIT_BLOB,s.path,__gSyncFlow?__gSyncFlow.integrityErrorMessage(s.path,"上传内容校验"):"数据完整性异常: 上传内容校验失败")}catch(_e){if(_e&&_e.__sgspIntegrity)throw _e}if(o>=xi)throw new Jt(Ge.LIMITED,`${s.path} ${this.i18n.fileSizeOver} ${xi}MB`);';
  js = js.split(up1Anchor).join(up1Inject);

  const up2Anchor = 'if(o>=La)throw new Jt(Ge.LIMITED,`${s.path} ${this.i18n.fileSizeOver} ${xi}MB`);';
  const up2Count = js.split(up2Anchor).length - 1;
  if (up2Count !== 1) fail("addFileToWorkArea 版本2 大小校验锚点数量异常: " + up2Count);
  const up2Inject =
    'try{if(__gSyncFlow&&!__gSyncFlow.contentIntegrityCheck(s.path,s.size,s.content))throw new Fe(ne.GIT_BLOB,s.path,__gSyncFlow?__gSyncFlow.integrityErrorMessage(s.path,"上传内容校验"):"数据完整性异常: 上传内容校验失败")}catch(_e){if(_e&&_e.__sgspIntegrity)throw _e}if(o>=La)throw new Jt(Ge.LIMITED,`${s.path} ${this.i18n.fileSizeOver} ${xi}MB`);';
  js = js.split(up2Anchor).join(up2Inject);

  /* ---------- 7.5 P0 数据安全: 主流程 BASE-tree 构建 p 时过滤同步范围外文件 ---------- */
  // BASE tree 来自上次同步的 commit,若当前同步范围已缩小,范围外的文件
  // 会被 !K.includes(L.path) 当成「本地删除」→ 生成远端删除。这里先过滤:
  // 不在当前同步范围的文件一律不进 workArea(不删除、不上传)。
  const pBuildAnchor = 'if(!K.includes(L.path)){let oe=Q.basename(L.path),V={sha:L.sha,mode:"100644",type:L.type,name:oe,path:L.path,status:Rt,updated:new Date(new Date(_.date).getTime()+Es)};p.push(V)}';
  assertAnchor(js, pBuildAnchor, "主流程 BASE-tree p 构建");
  const pBuildInject =
    'if(!K.includes(L.path)){let __p0skip=!1;try{__p0skip=!!(__gSyncFlow&&!__gSyncFlow.inSyncScope(L.path))}catch(_e){}if(__p0skip){try{__gSyncFlow&&__gSyncFlow.addLog("warn","跳过同步范围外文件(不删除): "+L.path)}catch(_e){}}else{let oe=Q.basename(L.path),V={sha:L.sha,mode:"100644",type:L.type,name:oe,path:L.path,status:Rt,updated:new Date(new Date(_.date).getTime()+Es)};p.push(V)}}';
  js = js.replace(pBuildAnchor, pBuildInject);

  // handleLocalCoverRemote 的 R 构建同样过滤
  const rBuildAnchor = 'if(!O.includes(I.path)){let te=Q.basename(I.path),C={sha:I.sha,mode:"100644",type:I.type,name:te,path:I.path,status:Rt,updated:new Date(new Date(h.date).getTime()+Es)};R.push(C)}';
  assertAnchor(js, rBuildAnchor, "handleLocalCoverRemote R 构建");
  const rBuildInject =
    'if(!O.includes(I.path)){let __p0skip2=!1;try{__p0skip2=!!(__gSyncFlow&&!__gSyncFlow.inSyncScope(I.path))}catch(_e){}if(__p0skip2){try{__gSyncFlow&&__gSyncFlow.addLog("warn","跳过同步范围外文件(不删除): "+I.path)}catch(_e){}}else{let te=Q.basename(I.path),C={sha:I.sha,mode:"100644",type:I.type,name:te,path:I.path,status:Rt,updated:new Date(new Date(h.date).getTime()+Es)};R.push(C)}}';
  js = js.replace(rBuildAnchor, rBuildInject);

  /* ---------- 7.6 P0: 每次成功同步后保存本地文件清单 ---------- */
  // 本地清单 = 同步完成后当前同步范围内本地确实存在的文件路径集合。
  // 它是删除安全判定的证据: 只有清单中存在某路径,才证明「本地曾经拥有」。
  // 三个同步入口(自动/远端覆盖本地/本地覆盖远端)成功后都会重建清单。
  const mkManifestSave = (okVar) =>
    "if(" +
    okVar +
    ".successed)this.settingUtils.setAndSave(De," +
    okVar +
    '.sha),this.settingUtils.setAndSave(rt,new Date().toLocaleString()),(async()=>{try{const __p0roots=await Ir(Number(this.settingUtils.get(Pe)),"/*"),__p0files=await this.handleWorkSpaceModifyFileList(__p0roots,!1,"/*");__gSyncFlow&&__gSyncFlow.saveLocalManifest((__p0files||[]).map(z=>z&&z.path?z.path:""))}catch(_e){try{__gSyncFlow&&__gSyncFlow.addLog("error","本地文件清单保存失败: "+((_e&&_e.message)||_e))}catch(_e2){}}})().catch(function(){})';
  const successAnchors = [
    ['handleRemoteCoverLocal', 'O', 'if(O.successed)this.settingUtils.setAndSave(De,O.sha)'],
    ['handleLocalCoverRemote', 'x', 'if(x.successed)this.settingUtils.setAndSave(De,x.sha)'],
    ['handleAutoRemoteAndLocalFileSync', 'Z', 'if(S.info("commitResponse:",Z),Z.successed)this.settingUtils.setAndSave(De,Z.sha)'],
  ];
  for (const [label, okVar, anchor] of successAnchors) {
    assertAnchor(js, anchor, label + " 成功分支");
    js = js.replace(anchor, mkManifestSave(okVar));
  }

  /* ---------- 7.7 P0 数据完整性: 远端下载写入前空内容防护 ---------- */
  // 远端 blob 为 0 字节但本地已存在该文件时,禁止空内容覆盖本地已有内容。
  // 触发时抛出 Fe(GIT_BLOB) → 整次同步失败、保留本地文件。
  // 注入点: 3 处「远端下载 → 写本地」的 ue(...) 调用。
  const dlAnchor = 'let w=await this.getRepoFileContent(h,n.sha);await ue(';
  const dlCount = js.split(dlAnchor).length - 1;
  if (dlCount !== 4) fail("远端下载写入锚点数量异常: " + dlCount + "(应为 4)");
  const dlInject =
    'let w=await this.getRepoFileContent(h,n.sha);try{let __p0dst=!(w&&w.content&&w.content.length===0);if(!__p0dst&&__gSyncFlow&&await __gSyncFlow.localFileExists(h)){__p0dst=!1;throw new Fe(ne.GIT_BLOB,h,"数据完整性异常: 远端内容为空,拒绝覆盖本地文件")}}catch(_e){if(_e&&_e.code===ne.GIT_BLOB)throw _e}await ue(';
  js = js.split(dlAnchor).join(dlInject);
  // handlerLocalModifyDataSync 的 y.content 下载分支(新增/下载而非覆盖)
  const dlYAnchor = 'await ue(h,!1,new Blob([y.content]),de,u,"create")';
  const dlYCount = js.split(dlYAnchor).length - 1;
  if (dlYCount < 1) fail("y.content 下载写入锚点缺失");
  const dlYInject =
    'try{let __p0dst2=!(y&&y.content&&y.content.length===0);if(!__p0dst2&&__gSyncFlow&&await __gSyncFlow.localFileExists(h)){__p0dst2=!1;throw new Fe(ne.GIT_BLOB,h,"数据完整性异常: 远端内容为空,拒绝覆盖本地文件")}}catch(_e){if(_e&&_e.code===ne.GIT_BLOB)throw _e}await ue(h,!1,new Blob([y.content]),de,u,"create")';
  js = js.split(dlYAnchor).join(dlYInject);

  /* ---------- 8. gitUtil 错误向状态机传播 ---------- */
  const anchorsGitUtil = [
    'He([we({rethrow:!1})],xe.prototype,"handleRemoteCoverLocal")',
    'He([we({rethrow:!1})],xe.prototype,"handleLocalCoverRemote")',
    'He([we({rethrow:!1})],xe.prototype,"handleAutoRemoteAndLocalFileSync")',
  ];
  for (const anchor of anchorsGitUtil) {
    assertAnchor(js, anchor, "gitUtil 同步错误传播");
    js = js.replace(anchor, anchor.replace("rethrow:!1", "rethrow:!0"));
  }

  /* ---------- 9. 设置面板新增开关(sgsp_sync_notify / sgsp_auto_retry) ---------- */
  const settingsAnchor = 's.addItem({key:"aboutHint",value:"",type:"hint",direction:"row",title:this.i18n.hintTitle,description:this.i18n.hintDesc})';
  const settingsCount = js.split(settingsAnchor).length - 1;
  if (settingsCount !== 2) {
    fail("设置面板 aboutHint 锚点数量异常: " + settingsCount + "(git/cloud 两个面板应各出现 1 次)");
  }
  const settingsItems =
    's.addItem({key:"sgsp_sync_notify",value:!0,type:"checkbox",title:this.i18n.sgspSyncNotifyTitle,description:this.i18n.sgspSyncNotifyDesc}),' +
    's.addItem({key:"sgsp_auto_retry",value:!1,type:"checkbox",title:this.i18n.sgspAutoRetryTitle,description:this.i18n.sgspAutoRetryDesc}),';
  js = js.split(settingsAnchor).join(settingsItems + settingsAnchor);

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

/** 就地写入版本号(默认 0.3.01,可用 GIT_SYNC_VERSION 覆盖) */
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