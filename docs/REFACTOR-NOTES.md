# 重构说明 / Refactor Notes

> 对象:`sy-git-sync-plugin` v0.3.0(官方 release 打包产物)
> 产物:仓库根目录即插件包(`index.js` 为注入后的构建产物,版本 `0.3.0-dev-00`)
> 代码:— `src/sync-flow-runtime.js`(新逻辑,单一事实来源)
>      — `patch/apply-patch.mjs`(注入/构建脚本)
>      — `tests/`(单元测试)、`smoke/verify.mjs`(端到端验证)
> CI:`.github/workflows/build.yml`(测试 → 构建 → 打包 → 发布)

## 1. 背景:官方仓库没有源码

官方 GitHub 仓库 `xstarling/sy-git-sync-plugin` 的 `main` 分支**只包含文档与资源文件**
(README、plugin.json、图标、预览图),真正的插件代码只以打包产物形式发布在
Release 附件的 `package.zip` 中(本仓库 `package/` 目录即 v0.3.0 解包结果,`index.js`
为压缩后的插件本体)。

因此本次重构选择:**对官方打包产物做可控的「源码级补丁注入」**,而不是重写同步算法。
所有注入点都有明确锚点、可审计、可回滚;同步/合并逻辑本身一行未改。

## 2. 重构前的问题(代码证据)

### 2.1 同步状态通知问题

- 冲突发生时,`handleAutoRemoteAndLocalFileSync` 等三个同步入口内部件
  `throw new Mr(dr.CONFLICT, path, i18n.fileConflictInfo)` 中断同步(bundle 中 6 处)。
- 该错误最终被类方法装饰器 `we({rethrow: !1})` 捕获,只调用 `handleSyncError`
  弹一条**瞬时** `showMessage` toast(约 3 秒),然后被吞掉。
- **自动同步定时器(`Vi`)不会因冲突停止**,每个同步间隔都会再次触发同步、
  再次冲突、再次弹 toast —— 用户被反复打扰,且没有「现在处于什么状态、
  该做什么」的指引。
- 没有持久化:重启后冲突状态丢失,只能靠再次同步撞出来。

### 2.2 文档问题

- 更新日志/功能列表/使用说明全部外链到金山文档(kdocs.cn),仓库内 README 本身
  信息量低,且很容易失效。
- 英文 README 术语错误:"Source Han Notes" / "Source Han Sans Notes"(
  应为 SiYuan Notes / 思源笔记),"asset"应为 "assets"。
- 中英文 README 表述不一致、存在错别字("请用户用户应自行评估使用风险")。
- 无冲突处理、同步状态相关说明。

## 3. 重构内容

### 3.1 新逻辑(只新增,不改动原有算法)

`src/sync-flow-runtime.js` 提供:

1. **状态机** `SyncState`:`idle / running / success / failed / conflict /
   conflict_paused / resolving / resolved`。
2. **冲突接管**:包装 `syncDataToCloud`,
   在错误链(cause 链,深度 ≤ 7)中识别 `code === 300`(dr.CONFLICT),
   接管后:置冲突状态 → 暂停自动同步定时器(`timerTask.removeSelf()`)→
   顶栏红色闪烁徽标 → 错误通知 → 持久化弹窗。
3. **暂停期拦截**:自动定时器触发(带 `autoTick` 标记)在暂停期内静默跳过,
   一个会话只提示一次;用户手动点击「开始同步」会重新弹出处理对话框。
4. **解决动作**:保留本地 → 强制 `localCoverRemote`;保留远端 → 强制
   `remoteCoverLocal`;成功后清空状态、移除徽标、恢复自动同步;失败则回到暂停态。
5. **持久化**:冲突暂停状态写入 `git-sync-flow.json`,重启后保持暂停。
6. **通知**:新增一条完整通知链路(见 `docs/CONFLICT-WORKFLOW.md`)。

### 3.2 注入点(共 5 处,全部为前置/包装式)

| # | 位置 | 改动 |
|---|---|---|
| 1 | `const q=require("siyuan");` 之后 | 注入运行时(状态机宿主工厂) |
| 2 | `onload` | 初始化宿主 + 恢复上次未解决的冲突暂停 |
| 3 | `onLayoutReady` | 刷新顶栏徽标 |
| 4 | `syncDataToCloud` | 原方法改名 `__gSyncDataToCloudBase`,新增包装方法(冲突接管入口) |
| 5 | `startAutoSync` | 定时回调打 `autoTick` 标记,用于区分「定时触发/用户触发」 |

另:i18n(15 个新文案键)、`index.css`(冲突徽标样式)、`plugin.json`(版本 0.3.0-dev-00)。

### 3.3 为什么这样设计

- 不改 `handleRemoteCoverLocal` / `handleLocalCoverRemote` / `handleAutoRemoteAndLocalFileSync`
  内部逻辑 → 回归风险最小。
- 强制覆盖模式(`force=true`)本身绕过三方合并,天然不会二次冲突,
  所以「保留本地/保留远端」是可靠的解决手段。
- 冲突错误被压缩器包装成 `Jt`/`Ht`(cause 链),因此冲突识别必须沿 cause 链查找,
  而不是只判断顶层错误。

## 4. 构建与验证

```bash
# 1) 单元测试(15 项)
node --test tests/sync-flow.test.mjs

# 2) 构建插件包文件(幂等;从 vendor/index.js 官方原版重新生成根目录 index.js,
#    并就地补齐 i18n / index.css / plugin.json;默认版本 0.3.0-dev-00,
#    可用 GIT_SYNC_VERSION 覆盖,CI 自动执行)
node patch/apply-patch.mjs

# 3) 端到端冒烟(用 siyuan stub 加载根目录 index.js,验证完整冲突闭环)
node smoke/verify.mjs
```

仓库根目录即插件包:`.github/workflows/build.yml` 会在 push/tag 时执行以上流程,
并把 `index.js + index.css + plugin.json + i18n/ + icon.png + preview.png + README*`
打包为 `GIT-SYNC-PLUGIN-<版本>.zip` 上传 artifact;推送 `v*` 标签时还会自动创建
GitHub Release 并附上 zip。

## 5. 安装与回滚

- 安装:把仓库根目录插件包文件(或 CI/Release 下载的 `GIT-SYNC-PLUGIN-<版本>.zip`)
  放到 `data/plugins/GIT-SYNC-PLUGIN/`,在思源里重新加载插件(或重启思源)。
- 回滚:删除 `data/plugins/GIT-SYNC-PLUGIN/`,从官方 Release 重新下载
  `package.zip` 解压安装即可恢复 v0.3.0。
- 若从 0.3.0-dev-00 回滚到官方版,冲突暂停状态文件
  (`data/storage/petal/GIT-SYNC-PLUGIN/git-sync-flow.json`)可手动删除。

## 6. 已知限制与后续建议

- **多设备并发**:本重构不做跨设备分布式锁/CAS;远端 HEAD 竞争仍依赖原插件
  的 Git API 操作(官方库不公开源码,无法在不重写的情况下加强)。
- **打开冲突文档**:尽力而为(内核 `searchDocs` + `openTab` 特性检测);
  找不到时引导用户到文件树手动打开。
- **建议的下一步**:把 `src/sync-flow-runtime.js` 的业务逻辑并入一份完整的
  TypeScript 源码工程(官方从未公开源码,可由社区按 `vendor/index.beautified.js`
  逐模块还原),届时可将补丁脚本替换为正式构建流程。
- 非冲突错误(网络/Token 等)的通知方式维持官方行为,未做改动。

## 7. 文件清单(本次新增/修改)

```
├── src/sync-flow-runtime.js     新增:状态机 + 冲突闭环 + 通知(单一事实来源)
├── patch/apply-patch.mjs       新增:注入/构建脚本
├── tests/sync-flow.test.mjs    新增:15 项单元测试
├── smoke/verify.mjs            新增:端到端冒烟验证
├── smoke/node_modules/siyuan/  新增:siyuan SDK stub(仅测试用)
├── docs/CONFLICT-WORKFLOW.md   新增:冲突处理闭环设计
├── docs/REFACTOR-NOTES.md      本文件
├── CHANGELOG.md                改写:仓库内自包含更新日志
├── README.md / README_zh_CN.md 改写:修复文档问题 + 新增状态章节
└── dist/GIT-SYNC-PLUGIN/       生成物:可安装插件包(v0.3.1)
```