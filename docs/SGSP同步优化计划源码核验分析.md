# SGSP 同步优化计划源码核验分析

## 1. 审查对象与结论

审查对象：`SGSP_同步优化计划与源码审计-20260902.md`

本次结合 SGSP 本地源码、构建脚本、测试和文档进行核验，结论如下：

> 报告的总体方向正确：SGSP 已经补齐了“冲突发生后的暂停、提示、人工处理、恢复”闭环，但还没有把原始 Git 同步逻辑升级为具备统一错误分类、远端竞争恢复和基准失效恢复能力的完整 Sync Engine。

不过，报告中部分内容是架构建议或合理推断，并非都已被当前源码直接证明。因此，该报告适合作为问题清单和演进方向，不能直接当作逐项实施清单。实施前应先完成代码级接口和状态设计。

## 2. 已被源码确认的判断

### 2.1 冲突处理闭环已经落地

`src/sync-flow-runtime.js:54-64` 定义了当前状态：

```text
idle
running
success
failed
conflict
conflict_paused
resolving
resolved
```

`src/sync-flow-runtime.js:614-648` 对同步异常进行接管，能够：

- 识别冲突错误；
- 进入 `CONFLICT_PAUSED`；
- 暂停自动同步；
- 显示通知和冲突弹窗；
- 持久化未解决冲突；
- 重新抛出非冲突异常；
- 解决失败时回到暂停状态。

当前测试覆盖了冲突错误链识别、定时器暂停、自动同步拦截、手动重新打开弹窗、保留本地、保留远端、解决失败、重启恢复和手动模式等场景。

### 2.2 三处原始同步入口已经改为重新抛出错误

`patch/apply-patch.mjs:292-301` 将以下三个入口的装饰器从 `rethrow:!1` 改为 `rethrow:!0`：

- `handleRemoteCoverLocal`；
- `handleLocalCoverRemote`；
- `handleAutoRemoteAndLocalFileSync`。

构建产物 `index.js` 中已经确认三处均为 `rethrow:!0`。这使 runtime 包装层可以收到原始冲突错误。

但重新抛出错误只是错误传播修复，不等于已经建立统一错误分类、错误持久化、重试和诊断系统。

### 2.3 非冲突错误仍没有统一错误体系

当前 `src/sync-flow-runtime.js:638-648` 对普通错误的处理主要是：

```text
FAILED
↓
formatErrorSummary()
↓
addLog()
↓
q.showMessage()
↓
throw 原错误
```

当前没有统一的 `SyncError`、错误类别、操作阶段、重试属性、恢复属性或同步操作 ID，也无法稳定区分网络、超时、认证、权限、仓库不存在、远端变化、Push 拒绝、大文件和本地文件错误。

因此报告关于“错误传播已经改善，但完整错误系统尚未建立”的判断成立。

### 2.4 普通日志只保存在内存中

`src/sync-flow-runtime.js:192` 创建内存日志数组，`addLog()` 在 `src/sync-flow-runtime.js:204-212` 中最多保留 200 条记录。

`persist()` 在 `src/sync-flow-runtime.js:265-279` 只保存冲突暂停状态，或在非暂停时保存空闲状态。当前没有完整的同步历史持久化文件，也没有保存最近 N 次同步结果。

因此思源重启后，普通同步失败日志会丢失；目前持久化的只是“未解决冲突”这一特殊状态。

### 2.5 `lastSyncCommit` 失效是现实薄弱点

以下同步方法都会读取设置中的上次提交 SHA，并调用 `getCommitInfo()` 验证：

- `handleRemoteCoverLocal()`：`vendor/index.beautified.js:9040-9053`；
- `handleLocalCoverRemote()`：`vendor/index.beautified.js:9284-9298`；
- `handleAutoRemoteAndLocalFileSync()`：`vendor/index.beautified.js:9429-9443`。

自动同步随后在 `vendor/index.beautified.js:9463` 使用：

```js
compareCommitFiles(w, F)
```

其中 `w` 是本地保存的基准提交，`F` 是远端分支最新提交。

当前没有看到以下恢复链路：

```text
lastSyncCommit 不存在
↓
寻找共同祖先
↓
重新建立 BASE
↓
继续三方同步
```

因此报告将基准 SHA 丢失列为高优先级风险是合理的。

## 3. 需要校准的报告判断

### 3.1 不是“没有三方合并”，而是缺少 Git 基准恢复

报告将 `compareCommits(base, head)` 与完整 Git 三方合并进行对比，方向有参考价值，但表述需要修正。

源码中的 `Ur()` 已经实现基于 `base / local / remote` 的文件内容级三方合并：

- 合并函数：`vendor/index.beautified.js:3577-3638`；
- 自动同步中的合并调用：`vendor/index.beautified.js:9748-9790`；
- 远端覆盖场景中的合并调用：`vendor/index.beautified.js:9965-10006`。

因此更准确的判断是：

> 当前已经具备文件内容级三方合并逻辑，但缺少 Git DAG 级基准解析、共同祖先恢复、分支关系判断和异常恢复编排。

后续不应重复实现已有的内容合并能力，而应围绕基准恢复、同步关系判断和错误恢复扩展。

### 3.2 Remote HEAD/CAS 风险不能表述为“会直接覆盖远端”

`vendor/index.beautified.js:10833-10870` 的提交流程确实是：

```text
createTree
↓
createCommit
↓
updateRef
```

但 `updateRef` 调用没有传 `force: true`。GitHub 分支引用更新默认要求快进更新，远端已经变化时通常会被服务端拒绝。因此当前问题不是简单的“无 CAS 导致静默覆盖”。

真实风险更接近：

1. 客户端读取远端 HEAD；
2. 基于该 HEAD 创建 tree 和 commit；
3. 远端在此期间发生变化；
4. `updateRef` 被拒绝；
5. 原代码捕获异常并重新读取远端分支；
6. 将远端最新 SHA 保存为本地基准；
7. 抛出同步失败。

相关代码见 `vendor/index.beautified.js:10906-10908`。

当前缺少：

- 显式的 `expectedRemoteHead`；
- `REMOTE_CHANGED` 和 `PUSH_REJECTED` 分类；
- 重新获取远端状态；
- 自动重新比较、合并和有限次数重试。

因此报告的 P0 优先级仍然成立，但建议将任务名称调整为：

> 远端引用竞争检测、失败分类与恢复重试。

### 3.3 不是“完全没有同步锁”，而是缺少统一 SyncQueue

原始插件存在 `isGitSyncing`，并在 `vendor/index.beautified.js:11329-11372` 阻止重复进入同步。Git 工具实例中也存在 `mutex`，例如 `vendor/index.beautified.js:10701` 和 `vendor/index.beautified.js:10923`，用于部分提交阶段的互斥。

因此报告称“完全没有锁”不准确。

当前真正的不足是：

- 没有覆盖所有触发源的统一同步队列；
- 自动同步、手动同步和冲突解决之间没有统一调度；
- runtime 依赖原插件的 `isGitSyncing`，自身没有完整并发协调；
- 冲突解决过程没有独立的操作上下文和队列语义。

更准确的结论是：

> 当前有单次同步保护和局部 mutex，但没有覆盖所有触发源和状态转换的统一 SyncQueue。

### 3.4 一次同步一个 Commit应作为目标，不应作为绝对规则

`addFileToWorkArea()` 在达到大小阈值后会调用 `commitAndPushFileToRemote()`，见 `vendor/index.beautified.js:10797-10805`。

`commitAndPushFileToRemote()` 会根据工作树大小分批提交，见 `vendor/index.beautified.js:10878-10895`。提交信息使用：

```js
`${new Date}_${t.slice}`
```

因此报告关于提交历史可读性差、一次同步可能生成多个 Commit 的判断成立。

但单次同步合并成一个 Commit 还受到 GitHub API 请求体、Blob 大小、内存和单次 tree 规模的限制。合理目标应为：

> 在不超过 API、Blob 和资源限制时，一次同步生成一个逻辑 Commit；超过限制时采用带同步 ID 和序号的可追踪批量 Commit。

## 4. 报告遗漏的源码风险

### 4.1 持久化失败被静默吞掉

`src/sync-flow-runtime.js:273-278` 中对 `plugin.saveData()` 使用了空的 `catch`：

```js
.catch(function () {})
```

持久化失败不会被记录或通知。这样可能出现用户看到冲突暂停，但重启后状态丢失且无法诊断的情况。

建议将“持久化失败可观测”列为高优先级任务。

### 4.2 错误摘要缺少明确的优先级策略

`getErrorSummary()` 位于 `src/sync-flow-runtime.js:138-159`，沿 `cause` 链查找错误，但一旦发现某层有 `status` 就立即返回。

当错误链类似：

```text
外层 HTTP 500 / 同步失败
↓
内层文件上传失败
```

可能只展示外层或中间层摘要，而不保留最具体的文件路径和底层消息。

问题的准确描述是：

> 当前错误摘要没有同时保留 HTTP 状态、操作阶段、文件路径和最具体底层消息的统一优先级策略。

### 4.3 冲突状态只能保存一个文件

`extractConflictInfo()` 返回单个：

```js
{
  path,
  message,
  name
}
```

`handleConflict()` 也只持久化一个 `conflictDetail`。一轮同步可能存在多个冲突文件，但当前状态没有冲突文件集合、冲突数量和完整列表。

后续 `SyncContext` 至少应考虑：

```text
conflicts[]
conflictCount
```

### 4.4 runtime 本身没有并发协调层

`src/sync-flow-runtime.js:556-649` 没有自己的运行中请求合并或排队机制。自动定时触发、手动点击、冲突解决和恢复流程依赖原插件的 `isGitSyncing` 保护，而不是由 SGSP 状态机统一调度。

这会限制后续实现重试、进度、取消和操作上下文。

### 4.5 patch 仍然依赖 bundle 结构

`patch/apply-patch.mjs` 使用字符串 Anchor 和方法体边界进行注入。Blob 预检会在两个同名 `addFileToWorkArea()` 方法中寻找包含 `rest.git.createBlob` 的目标方法，见 `patch/apply-patch.mjs:261-290`。

当前脚本具备 Anchor 唯一性检查，但没有 vendor 版本、SHA-256 或语义指纹校验。官方 bundle 升级后可能出现：

- Anchor 找不到导致构建失败；
- Anchor 仍存在但语义发生变化；
- 同名方法筛选规则不再匹配真正上传路径；
- patch 成功但行为覆盖不完整。

报告建议增加 Bundle Fingerprint 是合理的，且应将同名方法定位校验纳入其中。

## 5. 建议调整后的优先级

### P0：保证同步不会误判、丢失或破坏数据

1. 建立同步上下文，至少记录 `operationId`、`baseCommit`、`remoteHead`、本地变化和当前 phase。
2. 修复 `lastSyncCommit` 不存在时的恢复流程，禁止直接把不相关的远端提交当作本地已同步基准。
3. 完善远端引用竞争处理，区分远端变化和 Push 拒绝，重新获取状态并在必要时有限重试。
4. 建立覆盖自动同步、手动同步、冲突解决和重试操作的 `SyncQueue`。
5. 持久化失败必须记录并通知。

### P1：统一错误和可观测性

1. 定义 `SyncError` 结构。
2. 分类网络、超时、认证、权限、仓库不存在、分支不存在、远端变化、Push 拒绝、大文件、本地文件和 Git API 错误。
3. 增加 `retryable` 和 `recoverable` 属性。
4. 错误摘要同时保留 HTTP 状态、操作阶段、文件路径、最底层消息和脱敏后的详细信息。
5. 增加同步历史持久化。
6. 支持多个冲突文件的列表和数量。
7. 增加有限次数的重试和指数退避。

### P2：提交历史和构建可靠性

1. 无变化时不提交。
2. 单次同步尽量生成一个逻辑 Commit。
3. 批量提交使用带同步 ID 和序号的 Commit Message，例如：

```text
sync:<operationId>:part-1
```

4. patch 增加 vendor 版本、SHA-256、关键 Anchor 指纹、方法数量和目标方法校验。
5. 增加真实 Git API mock 或 integration 测试。

### P3：仓库展示层

目录重组、README 自动生成、Markdown 展示层和 Git LFS 等工作应放在同步正确性稳定之后。报告将仓库数据组织放在后续阶段，这一阶段划分是合理的。

## 6. 测试审计

当前测试主要验证：

```text
Fake Plugin
↓
Fake Sync Function
↓
Fake Error
↓
Runtime State Machine
```

测试适合验证状态机，但没有覆盖真实 Git API 流程：

```text
getCommitInfo
compareCommits
getTree
createBlob
createTree
createCommit
updateRef
```

建议补充以下测试：

1. `lastSyncCommit` 不存在；
2. 远端在读取 HEAD 后发生变化；
3. `updateRef` 返回 409 或 422；
4. Push 失败后是否错误更新本地基准；
5. 远端领先、本地领先、双方领先；
6. 删除与新增同路径；
7. 多冲突文件；
8. Blob 请求大小临界值；
9. 大文件预检异常；
10. 持久化读写失败；
11. 并发手动同步与自动同步；
12. patch 输入 bundle 指纹不匹配。

## 7. 本轮验证结果

本轮没有修改源码，仅执行了现有项目验证：

```text
node --test tests/sync-flow.test.mjs
16 tests passed, 0 failed
```

```text
node patch/apply-patch.mjs
构建通过
```

```text
node --check index.js
语法检查通过
```

```text
node smoke/verify.mjs
端到端冒烟验证通过
```

这些结果证明当前冲突闭环、补丁构建和冒烟流程可用，但不能证明报告规划的 Sync Engine 2.0 能力已经存在。

## 8. 最终判断

报告最值得保留的核心判断是：

> SGSP 主要解决了“冲突发生后如何让用户处理”，但尚未解决远端竞争、基准失效、失败恢复和统一可观测性。

实施前需要重点明确：

```text
现有内容级三方合并哪些保留
Git 基准如何恢复
远端 HEAD 竞争如何处理
失败时 lastSyncCommit 是否允许更新
runtime 与原插件 isGitSyncing 如何协作
SyncError / SyncContext 如何与现有异常类兼容
```

在这些接口和行为确定之前，不建议直接对 `vendor/index.beautified.js` 进行大规模修改。
