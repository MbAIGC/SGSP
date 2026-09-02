# DSF-SGSP 同步引擎重构实施计划

> 版本:0.2(待审核;按「通知问题提前」修订,M1 改为同步结果即时可见)
> 依据:
> - `docs/SGSP同步优化计划源码核验分析.md`(源码核验结论与 P0~P3 优先级)
> - `SGSP重构建议.md`(产品路线图与 0.4~0.8 版本规划,已按源码校准)
> - 用户反馈(2026-09-02):同步时用户不知道结果,要等很久翻 `/temp` 思源日志才知道出错,错误千奇百怪 → **通知与错误可见性为第一优先级**
> 本计划为**实施清单草案**,获批前不修改任何源码;获批后按里程碑逐项实施。

## 1. 任务目标

把 SGSP 从「冲突闭环 + 原有错误提示」升级为:同步过程与结果**即时、可见、可理解、可追溯**,并具备统一错误分类、远端竞争恢复、基准失效恢复和统一调度。

用户痛点优先排序(按反馈):

1. **同步结果用户不知道** —— 同步中无反馈、成败无提示、错误只在思源 temp 日志里;
2. **错误千奇百怪** —— 错误只有原始堆栈/英文消息,用户看不懂,也无处重试;
3. 冲突闭环已有,但只有冲突有完整通知;网络/Token/仓库等错误仍是「原有错误提示」。

目标链路:

```
Git 操作 → 错误分类(SyncError) → 同步状态机(SyncContext) → 即时通知(前端 toast/徽标/通知中心)
→ 结果持久化(历史可查) → 用户操作(重试/处理) → 自动恢复(有限重试)
```

不重复实现的内容(已核验为现状已具备):

- 文件内容级三方合并(`Ur()`,`vendor/index.beautified.js:3577-3638`,自动同步 `9748-9790`,远端覆盖 `9965-10006`);
- 冲突暂停/恢复闭环(`src/sync-flow-runtime.js` 8 状态状态机 + 持久化恢复);
- `lastSyncCommit` 作为 BASE 的三方比较(`vendor:9429-9463`);
- 大文件 Blob 请求大小预检(patch 已注入 `sgsp_blob_request_limit`)。

## 2. 现状基线(已核验)

| 项目 | 现状 | 出处 |
|---|---|---|
| 状态机 | 8 状态,冲突暂停持久化、重启恢复 | `runtime.js:55-64,265-280,283-300` |
| 非冲突错误 | FAILED + 摘要 toast + 运行日志,随后重抛 | `runtime.js:638-648` |
| 错误落点 | `saveToLogger()` = `S.error()`,**只进思源 temp 日志**,前端无反馈 | `vendor/index.js` 多处 |
| 错误传播 | 三入口 `rethrow:!0`,runtime 可收到原始错误 | `patch/apply-patch.mjs:292-301`,`index.js` 已确认 |
| 错误体系 | 无统一 SyncError/分类/重试/operationId;错误原文五花八门 | 全仓检索确认 |
| 日志 | 仅内存 200 条,重启丢失;持久化仅冲突暂停态 | `runtime.js:192,204-212,265-279` |
| 基准失效 | `lastSyncCommit` 失效无共同祖先恢复;首次同步回退分支初始 commit | `vendor:9040-9053,9284-9298,9429-9443` |
| 远端竞争 | `updateRef` 无 `force`;失败 catch 无条件把远端 SHA 存为本地基准 | `vendor:10852-10857,10906-10908` |
| 并发 | 原插件 `isGitSyncing` + gitUtil 局部 mutex,无统一队列 | `vendor:11329-11372,10701,10923` |
| 持久化失败 | `persist()` 空 catch 静默吞掉 | `runtime.js:273-278` |
| 冲突文件 | 只能持久化单个 `conflictDetail` | `runtime.js:111-128,535-549` |
| Commit 消息 | `${new Date}_${t.slice}`,可读性差、一次同步可能多 Commit | `vendor:10801,10881` |
| patch 可靠性 | 字符串锚点注入,有数量校验,无 vendor 指纹校验 | `patch/apply-patch.mjs:261-290` |
| 本地 Git | 不存在——纯 GitHub/Gitee REST API 同步 | 全仓检索确认 |

## 3. 阶段划分总览(按用户反馈重排:通知提前)

| 里程碑 | 对应版本 | 主题 | 主要来源 |
|---|---|---|---|
| M1 | SGSP 0.4 | **同步结果即时可见**(通知/错误可见性优先) | 用户反馈 + 重构建议阶段二、三 |
| M2 | SGSP 0.5 | 统一状态与错误基础设施(SyncContext/SyncError/SyncQueue) | 核验报告 P0/P1 |
| M3 | SGSP 0.6 | 同步引擎可靠性(基准恢复/竞争重试) | 核验报告 P0-2/P0-3 |
| M4 | SGSP 0.7~0.8 | 仓库质量与诊断(Commit 规范化/指纹/诊断/展示层) | 重构建议阶段四~十(已校准) |

每个里程碑结束均可独立发版,验证不通过的改动不进入下一里程碑。

## 4. 里程碑 M1:SGSP 0.4 —— 同步结果即时可见(最高优先级)

目标:**任何一次同步(自动/手动/解决冲突),开始、进行中、成功、失败都在前端可见、可查、可重试**,不再需要翻 `/temp` 日志。

### 4.1 任务清单

- **M1-01 同步全程即时通知**(核心痛点)
- **M1-02 错误分类基础版(SyncError 雏形)**(让「千奇百怪」变可理解)
- **M1-03 错误摘要增强**(HTTP 状态 + 阶段 + 文件路径 + 脱敏)
- **M1-04 同步结果持久化与历史可查**(失败不丢,重启可查)
- **M1-05 多冲突文件支持**(冲突通知显示数量与列表)
- **M1-06 轻量事件总线**(通知层与同步层解耦,为 M2 铺路)
- **M1-07 README/设置面板同步说明**(「保持原有错误提示」等过时描述修正)

### 4.2 关键方案

#### M1-01 同步全程即时通知

在 `runSync()`(`runtime.js:556-650`)入口/出口补齐四类通知,自动、手动、冲突解决三条路径全覆盖:

- **同步开始**:toast「🔄 开始同步…」+ 顶栏图标旋转(已有)+ 运行日志入栈;
- **同步中**:不轰炸;仅日志记录 phase(进度回调留给 M2);
- **成功**:toast「✅ 同步成功(3 个文件)」+ 状态徽标 🟢;
- **失败**:toast「❌ 同步失败:[分类中文摘要]」+ 徽标 🔴 + **通知中心常驻条目**(见 M1-04),toast 消失后仍可点开看详情/重试。

关键行为变化:

- 自动同步失败不再静默——toast + 常驻失败条目,用户随时可见;
- 失败详情可展开:分类、HTTP 状态、阶段、文件路径、脱敏底层消息;
- 提供「重试」按钮(重试走 M1-02 的 retryable 判断,不可重试的如 Token 错误给出引导文案)。

#### M1-02 错误分类基础版

最小可用的分类器 `classifyError(err)`(runtime 内,不依赖 bundle 内部符号,兼容现有 `cause` 链):

```js
{
  category: "NETWORK|AUTH|PERMISSION|REPOSITORY|BRANCH|REMOTE_CHANGED|PUSH_REJECTED|FILE|BLOB_LIMIT|GIT_API|CONFLICT|UNKNOWN",
  retryable: false,
  recoverable: false,   // 是否需要用户介入(如重新配置 Token)
  message: "",          // 用户可见中文摘要
  detail: "",           // 脱敏底层消息
}
```

分类依据(第一版,后续 M2 扩展字段):

| 特征(错误链中任一节点) | category | retryable | 用户可见文案 |
|---|---|---|---|
| `code === 300` | CONFLICT | ❌ | 「文件冲突,已暂停,请处理」 |
| 网络超时/连接重置/DNS(`code/status` 或 message 特征) | NETWORK | ✅ | 「网络连接失败,可重试」 |
| 401 | AUTH | ❌ | 「Token 无效,请重新配置」 |
| 403 | PERMISSION | ❌ | 「权限不足或 API 限流」 |
| 404(仓库/分支) | REPOSITORY / BRANCH | ❌ | 「仓库/分支不存在,请检查设置」 |
| 仓库为空 | REPOSITORY | ❌ | 「仓库为空,可初始化」 |
| `updateRef` 拒绝(409/422) | PUSH_REJECTED | ✅ | 「远端已变化,将重新同步」 |
| Blob 超限(`Ge.LIMITED` / `sgsp_blob_request_limit`) | BLOB_LIMIT | ❌ | 「文件过大,已跳过:[路径]」 |
| 其它 | UNKNOWN | ✅(有限) | 「未知错误,详情见日志」 |

要求:

- **任何错误都必须落到某个分类**,不允许出现用户看到原始英文堆栈而无解释;
- 分类器只增强展示,不改变「非冲突错误重抛」的语义,现有测试保持全绿。

#### M1-03 错误摘要增强

改造 `getErrorSummary()`(`runtime.js:138-159`):

- 不再「遇到第一个有 status 的节点即返回」,而是**遍历完整 cause 链**,同时保留:最外层 HTTP 状态、操作阶段、最具体文件路径、最底层消息;
- 摘要优先级:文件路径 > 底层消息 > HTTP 状态,保证不丢失具体文件信息;
- 脱敏规则沿用 `formatErrorSummary`(`runtime.js:161-168`),并扩展到 `detail` 字段;
- 千奇百怪的错误统一输出格式:一行分类摘要 + 可展开详情。

#### M1-04 同步结果持久化与历史可查

- 新增数据文件 `git-sync-history.json`,环形保留最近 N 次(默认 50)同步结果:
  `{ operationId, time, state, category, message, fileCount, retries }`;
- 每次同步结束写入一条;**失败条目必须有**,且重启后仍可查看(不再依赖 `/temp` 日志);
- 通知中心(简版):点击顶栏图标 → 最近同步结果列表(失败置顶,含重试/详情按钮);
- 持久化写入失败走可观测路径(`addLog` + notify,不静默)。

#### M1-05 多冲突文件支持

- `extractConflictInfo` 返回 `{ conflicts: [], conflictCount: N }`(兼容旧字段 `path/message/name` 取第一个);
- `host.conflictDetail` 升级为 `conflicts[]`,持久化格式增加 `conflicts` 字段;
- 兼容旧数据:`onAfterLoad` 读取旧单文件格式时自动迁移;
- 冲突通知显示「发现 N 个冲突文件」+ 列表,可逐个打开。

#### M1-06 轻量事件总线

在 runtime 内实现极简 Event Bus(不引依赖、遵守注入语法约束):

```js
syncEvents.emit("sync:start|success|error|conflict|paused|resumed|history", payload);
syncEvents.on("sync:error", showSyncError);
```

- 现有 `host.notify/addLog/setBadge/showConflictDialog` 改为订阅事件,对外行为不变;
- 事件 payload 统一携带分类结果与 operationId;M2 的 SyncContext/队列直接消费同一事件流。

#### M1-07 README/设置面板同步

- 更新 `README.md:108-112`「其它状态」:失败现在有分类摘要 + 常驻通知 + 历史;
- 设置面板新增开关:`sgsp_sync_notify`(成功通知开关,默认开)、`sgsp_auto_retry`(自动重试开关,默认关,见 M2)。

## 5. 里程碑 M2:SGSP 0.5 —— 统一状态与错误基础设施

目标:M1 的通知层之下,补齐状态上下文、完整错误体系与统一调度,支撑 M3 的重试/恢复。

### 5.1 任务清单

- **M2-01 定义 SyncContext**(核验报告 P0-1)
- **M2-02 完善 SyncError(完整字段 + 分类扩展)**(核验报告 P1-1/P1-2/P1-3)
- **M2-03 建立 SyncQueue 统一调度**(核验报告 P0-4)
- **M2-04 持久化失败可观测**(核验报告 P0-5)
- **M2-05 有限重试 + 指数退避**(核验报告 P1-7)
- **M2-06 通知中心完善(进度/去重/通知历史)**(重构建议阶段三)

### 5.2 关键方案

#### M2-01 SyncContext

在 `src/sync-flow-runtime.js` 宿主内新增:

```js
host.syncContext = {
  operationId: "sync-<ts>-<seq>", // 一次同步一个 ID,贯通通知/历史/Commit
  phase: "check|fetch|merge|commit|push|resolve",
  baseCommit: null,   // lastSyncCommit
  remoteHead: null,   // 本次读取的远端 HEAD
  localChanges: [],   // 本地变化文件列表
  startedAt: 0,
  finishedAt: 0,
  attempts: 0,        // 重试次数
};
```

- `runSync()` 入口创建,出口清理;phase 通过 patch 注入点在 gitUtil 关键调用前后更新(见 M3 的注入点表);
- operationId 同时用于 Commit Message 与诊断日志关联。

#### M2-02 SyncError 完整结构

在 M1-02 基础上扩展:

```js
{
  category, phase, status, path, message, detail,
  retryable, recoverable,
  cause, operationId, timestamp,
}
```

- 分类器 `classifyError` 升级为覆盖全部场景(含 `REMOTE_CHANGED`、Gitee 差异);
- 与现有异常类(`Ht/Fe/ze/Jt/Mr`)保持兼容:`classifyError` 只读特征、不吞错、不破坏现有测试。

#### M2-03 SyncQueue

在 runtime 内新增串行队列(不依赖外部库,遵守注入语法约束):

- 队列覆盖触发源:`runSync()` 全部入口(自动定时、手动点击、冲突解决、重试);
- 队列语义:同一时刻只允许一个同步操作;后到请求按「自动定时可跳过、手动/解决动作排队」策略处理;
- 与原插件 `isGitSyncing` 的关系:保留 `__gSyncDataToCloudBase` 内的 `isGitSyncing` 作为最后防线,队列在其上层;
- 冲突解决操作(RESOLVING)拥有独立优先级,允许排队在普通同步之前。

#### M2-04 持久化失败可观测

`persist()`(`runtime.js:265-279`)改造:

- `.catch(function () {})` 改为记录 `addLog("error", "持久化失败: " + 摘要)` + 一次 notify;
- 冲突暂停持久化失败时,**保持内存态暂停**并提示用户「重启后可能丢失暂停状态」;
- 增加对应测试用例(持久化读写失败)。

#### M2-05 有限重试 + 指数退避

- 仅对 `retryable: true` 的错误生效(`sgsp_auto_retry` 默认关,用户显式开启);
- 上限 3 次,退避 `2^n * 5s`(n=0,1,2);
- 重试期间状态为 `RETRYING`,前端可见(复用 M1 通知通道);
- Token 类错误(AUTH/PERMISSION)不重试,直接 FAILED + 引导重新配置。

#### M2-06 通知中心完善

- 复用现有运行日志面板(`showRuntimeLogs`)与历史面板(`openSyncHistoryPanel`)基础;
- 集中式通知列表:顶栏徽标点击后展示「失败(可重试/详情) + 冲突(处理) + 最近成功」;
- 通知去重:同一 `operationId` 只展示一次;自动同步会话内同类错误只提示一次;
- 不引入新 UI 框架,沿用思源 `q.Dialog` + 现有面板风格。

## 6. 里程碑 M3:SGSP 0.6 —— 同步引擎可靠性

目标:降低「同步条件苛刻」导致的失败,解决远端竞争与基准失效(核验报告 P0-2/P0-3)。

### 6.1 任务清单

- **M3-01 lastSyncCommit 基准失效恢复**(P0-2)
- **M3-02 远端引用竞争检测与分类**(P0-3)
- **M3-03 push rejected 自动重取 + 三方合并 + 有限重试**(P0-3)
- **M3-04 失败时 lastSyncCommit 更新策略**(决策点,见 §10)

### 6.2 关键方案

#### M3-01 基准失效恢复

现状(`vendor:9040-9053 / 9284-9298 / 9429-9443`):`lastSyncCommit` 为空时回退分支初始 commit;存在但 `getCommitInfo` 失败时直接抛 NOT_FOUND。

目标流程(patch 注入包装):

```text
lastSyncCommit 存在
  → getCommitInfo 验证
  → 失效:
      ├─ 有本地提交记录 → 用 compareCommits 找共同祖先 → 重建 BASE
      └─ 无共同祖先(全新/历史重写) → 停止并提示用户重建基准(禁止静默取远端 HEAD 当基准)
```

- 禁止「把不相关远端提交直接当作本地已同步基准」;
- 提供设置项操作「重置同步基准」(重置 `De` 设置,复用现有 confirm 流程)。

#### M3-02/03 远端竞争检测与恢复

现状(`vendor:10906-10908`):`commitAndPushFileToRemote` 的 catch **无条件** `getCommitInfo(远端) → setAndSave(De, 远端 SHA) → 抛错`,会把失败当成功基准。

目标流程(patch 注入 `commitAndPushFileToRemote` 包装):

```text
updateRef 失败
  → 分类:
      409/422 非快进 → REMOTE_CHANGED / PUSH_REJECTED
      其它(网络/认证/权限) → 对应 SyncError,不更新基准
  → REMOTE_CHANGED:
      重取远端 HEAD → 与本地变化三方合并(复用 Ur)
      → 无冲突:提交 → 重试 updateRef(≤3 次,指数退避)
      → 有冲突:进入 CONFLICT 流程(不更新 lastSyncCommit)
  → 成功后才允许更新 lastSyncCommit
```

- 需要新增 patch 注入点(见 §8 注入点表);
- GitHub 与 Gitee 两套 gitUtil 分别适配(Gitee 走 `createOrUpdateFile` 逐文件提交,竞争语义不同)。

## 7. 里程碑 M4:SGSP 0.7~0.8 —— 仓库质量与诊断

目标:GitHub 仓库干净可读,同步问题可诊断。

### 7.1 任务清单

- **M4-01 无变化不提交(流程层短路)**(P2-1)
- **M4-02 单次同步一个逻辑 Commit**(P2-2)
- **M4-03 Commit Message 规范化**(P2-3,采用 `sync:<operationId>:part-N` 或 `sync: <动作> <数量>`)
- **M4-04 patch Bundle Fingerprint 校验**(P2-4)
- **M4-05 真实 Git API mock 测试**(P2-5)
- **M4-06 同步诊断(REST 版)**(重构建议阶段十,已剔除本地 Git 假设)
- **M4-07 仓库展示层(延迟项)**(P3,同步正确性稳定后再做)

### 7.2 关键方案

#### M4-04 Bundle Fingerprint

`patch/apply-patch.mjs` 增加:

- `vendor/index.js` SHA-256 指纹,存 `patch/fingerprint.json`;
- 关键 Anchor 指纹 + 方法数量校验(已有 `addFileToWorkArea === 2` 模式推广到全部注入点);
- 指纹不匹配时**构建失败并提示升级流程**,而不是带病注入。

#### M4-01/02/03 Commit 规范化

- 流程层:三方比较后本地无变化 → 直接 SUCCESS,不执行提交链路;
- 提交层:保留 `workTrees` 分批限制(API/Blob 限制),但 Commit Message 改为:
  - 单批:`sync: <operationId> <动作摘要>`(如 `sync: update 3 files`);
  - 多批:`sync: <operationId>:part-N`;
- 无变化时不再显示「同步成功」误导提示(现状 `vendor:9592` 无条件 setAndSave + 成功 toast)。

#### M4-05 真实 API mock 测试

- 引入 octokit 层 mock(不依赖真实网络),覆盖:基准失效、远端竞争 409/422、push 失败后基准不被污染、多冲突文件、Blob 临界值、持久化失败、并发手动+自动;
- 补充进 `tests/`,与现有状态机测试并列。

#### M4-06 同步诊断(REST 版)

设置面板新增「同步诊断」,检查项(REST 架构版):

```
Token 有效性 / GitHub API 连通 / Repository 存在 / Branch 存在
推送权限 / 本地工作区可读 / 大文件清单 / 当前基准与远端 HEAD / 冲突文件数
```

删除重构建议中的「Git 是否安装 / git status / fetch / pull」等本地 git 项。

#### M4-07 仓库展示层(延迟)

- `notes/ assets/ system/ .sgsp/` 目录重组、README 自动生成、Markdown 展示:全部放同步正确性稳定之后;
- Git LFS:**标注为架构不可行**(纯 REST API 无 git 协议),替代方案为大文件分级警告 + 上限拒绝。

## 8. 修改范围汇总

| 文件 | 改动性质 |
|---|---|
| `src/sync-flow-runtime.js` | 主要:通知/分类器/历史持久化/事件总线/M1~M2 全部 |
| `patch/apply-patch.mjs` | 新增注入点(phase 更新、commitAndPushFileToRemote 包装)+ 指纹校验(M4) |
| `index.js` | 构建产物,由 patch 生成,随里程碑重建提交 |
| `tests/sync-flow.test.mjs` | 扩展分类器/队列/多冲突/持久化失败/通知用例 |
| `tests/`(新增) | API mock 集成测试(M4) |
| `smoke/verify.mjs` | 扩展冒烟断言(失败通知、分类摘要) |
| `i18n/zh_CN.json`、`i18n/en_US.json` | 新增文案(错误分类、通知中心、历史) |
| `README.md` | 修正「保持原有错误提示」等过时描述 |
| `plugin.json` | 版本号随里程碑递增(0.4.x → 0.5.x → 0.6.x) |

不直接修改 `vendor/index.beautified.js`(只读参照);所有对 bundle 的改动经 `patch/apply-patch.mjs` 注入。

## 9. 验证方式

每个里程碑完成时执行(与现状基线一致的命令):

```text
node --test tests/sync-flow.test.mjs         # 现有 16 用例必须全绿
node patch/apply-patch.mjs                   # 构建通过(先在副本验证产物与基线一致)
node --check index.js                        # 产物语法检查
node smoke/verify.mjs                        # 端到端冒烟
```

新增用例(按里程碑):

- M1:四类通知触发、错误分类映射(含 UNKNOWN 兜底)、摘要链优先级、历史持久化与重启恢复、多冲突文件、失败条目常驻;
- M2:事件总线订阅/去重、队列互斥与跳过、持久化失败、重试退避、RETRYING 状态;
- M3:基准失效重建/禁止静默、409/422 竞争重试、push 失败后 `lastSyncCommit` 不被污染、Gitee 差异;
- M4:指纹不匹配构建失败、无变化短路、Commit Message 格式、API mock 全链路。

## 10. 决策点(需用户确认后实施)

1. **失败时是否允许更新 `lastSyncCommit`**:建议仅成功后才更新;竞争失败恢复成功后可更新。确认?
2. **自动重试默认开关**:建议默认关(`sgsp_auto_retry`),用户显式开启。确认?
3. **一次同步一个 Commit 的取舍**:受 GitHub API 请求体/Blob/内存限制,超过限制时接受多 Commit(`:part-N`)。确认?
4. **冲突自动恢复策略**:保留「用户手动选择方向」,不自动选边。确认?
5. **大文件分级阈值**:建议沿用现有 40MB 硬限 + 32MB 请求预检,新增 10MB 警告。确认?
6. **里程碑节奏**:M1(通知可见)→ M2(状态基础设施)→ M3(引擎可靠性)→ M4(仓库质量);M4-04(指纹)可提前到 M1 之前。确认?
7. **成功通知是否默认开启**:建议默认开(用户反馈「不知道结果」主要缺成功/失败反馈)。确认?

## 11. 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| patch 锚点随官方 bundle 升级失效 | M4-04 指纹校验前置;锚点唯一性检查已有,扩展语义指纹 |
| 注入代码语法约束(无 `?.`/模板字符串/`??`) | 新代码严格遵循 `runtime.js` 头部注释的语法约束;构建期 `node --check` 兜底 |
| 持久化格式变更(conflicts[]/history) | 旧数据自动迁移,保留单文件兼容字段 |
| 错误分类误判影响现有行为 | 分类器只增强不吞错;非冲突错误保持「重抛原错误」语义;UNKNOWN 兜底保证永远有解释 |
| 通知轰炸(自动同步频繁失败) | 去重:同一会话同类错误只提示一次;失败条目常驻但 toast 去重 |
| 竞争重试可能放大远端负载 | 上限 3 次 + 指数退避 + 仅 `retryable` 错误 |
| 重构建议中本地 Git/LFS 假设 | 已在计划中剔除/改写为 REST 架构方案 |

## 12. 明确不做(范围外)

- 不重复实现已存在的文件内容级三方合并;
- 不做 Git LFS(架构不可行);
- 不做未批准的额外重构、代码清理或架构调整;
- 不直接修改 `vendor/index.beautified.js`。
