# SGSP 同步引擎 2.0 可落地实施方案

## 1. 决策与目标

### 1.1 已确认决策

从 Sync Engine 2.0 开始，**不再采用 `patch/apply-patch.mjs` 注入、字符串 Anchor 替换、运行时包装原始 bundle 的方案**。

以下文件不再作为新同步能力的实现路径：

```text
patch/apply-patch.mjs
vendor/index.js
vendor/index.beautified.js
```

它们在迁移期仅作为：

- 现有发布版本的回滚基线；
- 行为参考；
- 兼容性核验材料；
- 历史数据格式和设置项的逆向依据。

新版本的同步功能必须由可读、可测试、可维护的源码实现，构建产物由标准构建链路生成，而不是通过修改压缩 bundle 生成。

### 1.2 目标

建立一套支持 GitHub 和 Gitee 的独立同步引擎，满足以下目标：

1. 不依赖压缩 bundle 的内部变量名、字符串或方法结构。
2. 每次同步具有可追踪的上下文、阶段、结果和错误。
3. 远端变化、Push 竞争、网络异常、认证异常和基准丢失都可被区分、呈现和恢复。
4. 不通过静默覆盖、错误更新基准或吞掉异常来伪造同步成功。
5. 本地与远端发生同时修改时，优先三方合并；无法自动合并时进入持久化冲突状态，等待用户确认。
6. 只有同步结果经远端确认后，才更新本地同步基准。
7. 可测试、可灰度、可回滚，并保留对旧版本同步元数据的兼容迁移能力。

### 1.3 数据安全边界

没有任何多设备同步系统能保证“绝对没有冲突”。网络中断、用户在多端同时修改同一文件、远端强制改写历史、仓库被删除或令牌权限变化都可能发生。

本方案的安全承诺是：

- 不把无法确认的状态标为成功；
- 不在远端基准不明时自动覆盖远端；
- 不在 Push 失败时把远端 HEAD 直接写为本地已同步基准；
- 冲突时保留 base、local、remote 三份信息或可恢复引用；
- 每次破坏性动作前保存可恢复记录；
- 自动重试只用于幂等、可判定且不会扩大写入风险的错误。

## 2. 当前实现的处置

### 2.1 现有 bundle 的定位

当前同步实现主要位于 `vendor/index.beautified.js`，其中包含：

- GitHub 和 Gitee API 调用；
- 文件级内容三方合并；
- 初次同步；
- 本地覆盖远端和远端覆盖本地；
- 思源格式和 Markdown 格式处理；
- 文件范围、忽略规则、资源处理；
- 分批提交；
- 同步历史界面。

新引擎不复制压缩命名和控制流，而是将已确认的用户行为转化为可测试的领域模型和接口。

### 2.2 旧实现的退出策略

1. 先发布不含新引擎功能的稳定维护版本，保留旧版包作为可安装回滚包。
2. 新引擎以独立源码和独立入口实现，不调用旧 bundle 的同步方法。
3. 新引擎稳定前，旧版与新版本不在同一个插件目录中混装。
4. 新版本首次启动时只迁移设置和同步元数据，不自动执行写入型同步。
5. 用户首次启用新引擎时先运行只读诊断和预览，确认后才允许首次写入同步。
6. 新引擎连续稳定发布后，移除 `patch/`、`vendor/` 和与补丁生成相关的 CI 步骤；保留旧版本安装包和迁移说明。

### 2.3 不能迁移的做法

以下行为禁止在新引擎中保留：

- 根据字符串 Anchor 修改生成后的 JavaScript；
- 使用压缩变量名作为跨模块契约；
- 捕获错误后空 `catch`；
- 失败时无条件更新 `lastSyncCommit`；
- 无上下文的 `showMessage("同步失败")`；
- 未验证远端关系时强制更新分支引用；
- 仅以时间戳作为批量提交的可追踪标识。

## 3. 目标架构

```text
插件入口与 UI
      │
      ▼
SyncController
      │
      ├── SyncQueue
      ├── SyncContext / SyncState
      ├── SyncError 归一化
      ├── SyncHistoryStore
      └── NotificationService
      │
      ▼
SyncEngine
      │
      ├── LocalWorkspaceAdapter
      ├── SyncPlanner
      ├── ThreeWayMerger
      ├── ConflictService
      ├── CommitBuilder
      └── GitProvider
              ├── GitHubProvider
              └── GiteeProvider
```

职责边界：

| 模块 | 职责 | 禁止承担的职责 |
|---|---|---|
| `SyncController` | 入口、队列、状态转换、UI 事件 | Git API 细节、文件合并细节 |
| `SyncEngine` | 读取状态、生成计划、执行同步、提交结果 | 直接操作页面 UI |
| `GitProvider` | 分支、提交、树、Blob、Ref API | 思源文件扫描和合并决策 |
| `LocalWorkspaceAdapter` | 扫描、读写、忽略规则、思源格式转换 | 远端 API 调用 |
| `ThreeWayMerger` | 内容级三方合并与冲突描述 | 提交、通知和配置持久化 |
| `ConflictService` | 冲突快照、用户决策、恢复动作 | 自动强制覆盖 |
| `SyncHistoryStore` | 状态、事件、失败历史、基准元数据 | Token 等敏感凭据存储 |

## 4. 源码目录与文件边界

建议创建新的源码目录，不与旧 runtime 或 patch 混合：

```text
src/
├── plugin/
│   ├── index.js
│   ├── lifecycle.js
│   └── menu.js
├── sync/
│   ├── sync-controller.js
│   ├── sync-engine.js
│   ├── sync-queue.js
│   ├── sync-context.js
│   ├── sync-state.js
│   ├── sync-error.js
│   ├── sync-planner.js
│   ├── commit-builder.js
│   ├── three-way-merger.js
│   ├── conflict-service.js
│   └── retry-policy.js
├── git/
│   ├── git-provider.js
│   ├── github-provider.js
│   ├── gitee-provider.js
│   └── git-error-normalizer.js
├── local/
│   ├── workspace-adapter.js
│   ├── file-scanner.js
│   ├── ignore-rules.js
│   └── content-adapter.js
├── storage/
│   ├── sync-history-store.js
│   ├── sync-metadata-store.js
│   └── migration.js
└── ui/
    ├── sync-status-service.js
    ├── notification-service.js
    └── conflict-dialog.js
```

测试目录与源码一一对应：

```text
tests/
├── sync/
├── git/
├── local/
├── storage/
├── integration/
└── fixtures/
```

## 5. 核心数据契约

### 5.1 SyncContext

每次请求创建唯一 `SyncContext`，不得复用：

```js
{
  id: "sync-20260902-001",
  trigger: "manual" | "automatic" | "startup" | "retry" | "conflict_resolution",
  mode: "auto" | "remote_over_local" | "local_over_remote",
  startedAt: "2026-09-02T16:32:00.000Z",
  finishedAt: null,
  phase: "checking",
  state: "CHECKING",
  attempt: 0,
  baseCommit: null,
  expectedRemoteHead: null,
  observedRemoteHead: null,
  localSnapshotId: null,
  plan: null,
  result: null,
  error: null,
  conflicts: []
}
```

约束：

- `baseCommit` 是上一次双方已确认同步完成的共同提交，不是“最后一次看到的远端提交”。
- `expectedRemoteHead` 是本轮基于其构建提交的远端 HEAD。
- `observedRemoteHead` 记录 Push 前二次读取的远端 HEAD。
- `result` 只有在远端引用更新成功并回读确认后才可标记成功。

### 5.2 SyncState

```text
IDLE
QUEUED
CHECKING
SNAPSHOTTING_LOCAL
FETCHING_REMOTE
RESOLVING_BASE
PLANNING
MERGING
CONFLICT_PAUSED
COMMITTING
VERIFYING_REMOTE_HEAD
PUSHING
RETRYING
SUCCESS
FAILED
CANCELLED
```

状态转换约束：

```text
任何状态 ──不可恢复错误──▶ FAILED
MERGING ──不可自动合并──▶ CONFLICT_PAUSED
PUSHING ──远端已变化──▶ FETCHING_REMOTE 或 RETRYING
SUCCESS ──保存基准和历史──▶ IDLE
FAILED / CONFLICT_PAUSED 不得自动改写 BASE
```

### 5.3 SyncError

```js
{
  category: "NETWORK" | "TIMEOUT" | "AUTH" | "PERMISSION" |
            "REPOSITORY" | "BRANCH" | "REMOTE_CHANGED" |
            "PUSH_REJECTED" | "CONFLICT" | "LARGE_FILE" |
            "LOCAL_FILE" | "GIT" | "CANCELLED" | "UNKNOWN",
  code: "HTTP_409",
  operation: "updateRef",
  phase: "PUSHING",
  httpStatus: 409,
  path: "data/notebook/doc.sy",
  message: "远端分支已变化，当前提交未写入",
  detail: "脱敏后的底层错误摘要",
  retryable: true,
  recoverable: true,
  cause: null
}
```

规范：

- `message` 必须可直接展示给用户；
- `detail` 用于诊断，必须脱敏；
- 原始 Error 仅保存在内存或受控诊断日志中，不能写入可能同步的目录；
- `category` 决定重试、弹窗和状态颜色，不允许 UI 从字符串猜测错误类型。

### 5.4 SyncMetadata

将同步元数据保存在插件私有数据目录，例如：

```text
data/storage/petal/SGSP/sync-metadata.json
```

结构：

```js
{
  schemaVersion: 1,
  repositories: {
    "github:owner/repo:main": {
      lastConfirmedCommit: "sha",
      lastSuccessfulAt: "2026-09-02T16:32:00.000Z",
      lastOperationId: "sync-20260902-001"
    }
  }
}
```

约束：

- 不存 Token、SSH 私钥、Authorization Header；
- 按远端平台、仓库和分支隔离基准；
- 不把元数据放入同步工作区，避免同步到远端仓库；
- 写入需原子化，失败必须暴露为 `LOCAL_FILE` 或 `GIT` 类错误。

## 6. Git Provider 契约

### 6.1 抽象接口

```js
class GitProvider {
  async getBranchHead(repository) {}
  async getCommit(repository, sha) {}
  async getTree(repository, treeSha) {}
  async getBlob(repository, blobSha) {}
  async compareCommits(repository, base, head) {}
  async createBlob(repository, content, encoding) {}
  async createTree(repository, baseTreeSha, entries) {}
  async createCommit(repository, message, treeSha, parentShas) {}
  async updateBranchRef(repository, branch, sha, options) {}
  async getMergeBase(repository, leftSha, rightSha) {}
}
```

其中 `updateBranchRef()` 的 `options` 必须包含：

```js
{
  expectedHead: "sha",
  force: false
}
```

Provider 必须保证：

1. `force` 默认且固定为 `false`；
2. 无法提供服务端 compare-and-swap 的平台，必须在更新前二次读取 HEAD；
3. 更新失败后返回可识别的 `REMOTE_CHANGED` 或 `PUSH_REJECTED`；
4. 禁止 Provider 在失败分支擅自更新本地 BASE；
5. 所有远端错误必须转为 `SyncError`，不允许泄露 Token。

### 6.2 GitHub 实现

GitHub Provider 使用 Git Data API：

```text
getRef / getBranch
getCommit
getTree
getBlob
createBlob
createTree
createCommit
updateRef
```

安全流程：

```text
读取 remoteHead = A
↓
构建 tree 和 commit，parent = A
↓
再次读取 currentHead
↓
currentHead !== A
  ├── 是：不 updateRef，重新规划或进入冲突处理
  └── 否：updateRef(force=false)
↓
回读 branch HEAD
↓
HEAD === newCommit
  ├── 是：成功，更新 lastConfirmedCommit
  └── 否：失败，不更新 BASE
```

说明：二次读取不能替代服务端原子 CAS；真正的最终保护由 `updateRef(force=false)` 的快进约束和失败后恢复流程共同提供。若平台 API 支持显式旧 SHA 条件，应优先使用。

### 6.3 Gitee 实现

Gitee Provider 必须实现相同的领域契约，不允许把“逐文件创建内容 API”直接暴露给同步决策层。

如果 Gitee API 无法提供与 GitHub Git Data API 等价的原子树提交能力，则需要：

1. 记录操作 ID；
2. 在写入前再次确认远端 HEAD；
3. 对每个写入记录前映像和后映像；
4. 任意中途失败进入 `PARTIAL_REMOTE_WRITE` 错误；
5. 禁止自动标记成功；
6. 提供恢复向导，而不是盲目自动回滚或重放。

GitHub 与 Gitee 的原子能力不一致时，功能必须以较弱平台的安全边界为准展示，不能对用户承诺相同行为。

## 7. 同步算法

### 7.1 同步前置条件

同步开始前依次检查：

1. 配置完整性；
2. Token 或 SSH 凭据可用性；
3. 仓库存在性；
4. 分支存在性；
5. 本地工作区可读写；
6. 上轮是否处于 `CONFLICT_PAUSED`；
7. 同一仓库分支是否已有运行中同步。

任一步失败，创建 `SyncError`、写入历史、更新 UI；不得开始远端写入。

### 7.2 本地快照

开始同步时生成不可变本地快照：

```text
扫描同步范围
↓
应用 ignore 规则
↓
标准化路径
↓
读取文件元数据和内容摘要
↓
生成 localSnapshotId
```

快照必须包括：

```js
{
  path,
  kind: "file" | "deleted",
  contentHash,
  size,
  contentReference,
  format: "raw" | "siyuan" | "markdown"
}
```

同步期间若文件在本地再次变化，不把新变化混入本轮提交；下一轮同步重新扫描。这样可避免长时间上传时发生“读取版本和提交版本不一致”。

### 7.3 BASE 解析

解析顺序：

1. 读取 `lastConfirmedCommit`；
2. 在远端查询该提交；
3. 若提交存在，作为 BASE；
4. 若提交不存在，尝试通过 Provider 获取本地保存的祖先线索和远端提交图中的共同祖先；
5. 若找到共同祖先，进入三方同步；
6. 若无法证明共同祖先，进入 `BASE_UNRESOLVED` 错误和恢复向导，不自动覆盖任何一方。

恢复向导必须提供：

- 导出本地快照；
- 只下载远端到隔离目录；
- 生成差异预览；
- 明确选择“以本地为新基准”或“以远端为新基准”；
- 明确选择后创建新的确认提交或元数据记录。

禁止在 BASE 不存在时自动把当前远端 HEAD 写入 `lastConfirmedCommit`。

### 7.4 三方文件决策

对每个路径计算：

```text
BASE 状态
LOCAL 状态
REMOTE 状态
```

状态为：

```text
不存在
存在且内容未变
存在且内容已变
已删除
```

决策规则：

| BASE | LOCAL | REMOTE | 默认动作 |
|---|---|---|---|
| 无 | 新增 | 无 | 上传本地新增 |
| 无 | 无 | 新增 | 下载远端新增 |
| 无 | 新增 | 新增且不同 | 冲突 |
| 有 | 未变 | 远端变更 | 应用远端变更到本地 |
| 有 | 本地变更 | 未变 | 上传本地变更 |
| 有 | 本地变更 | 远端变更且相同 | 采用相同内容 |
| 有 | 本地变更 | 远端变更且不同 | 三方合并或冲突 |
| 有 | 本地删除 | 未变 | 提交删除 |
| 有 | 未变 | 远端删除 | 删除本地文件 |
| 有 | 本地删除 | 远端变更 | 冲突 |
| 有 | 本地变更 | 远端删除 | 冲突 |

任何删除操作必须满足：该文件在 BASE 中存在，且另一侧未发生独立修改。否则禁止自动删除。

### 7.5 内容合并

`ThreeWayMerger` 的输入和输出必须独立于思源 UI：

```js
merge({
  base: { content, format },
  local: { content, format },
  remote: { content, format },
  path
})
```

输出：

```js
{
  merged: true,
  content: "...",
  conflicts: [],
  strategy: "text-three-way"
}
```

或：

```js
{
  merged: false,
  content: null,
  conflicts: [{ path, reason, baseRef, localRef, remoteRef }],
  strategy: "manual-required"
}
```

规则：

- 文本文件使用确定性的三方合并；
- 二进制、超大文件和格式不可逆转换文件不做文本合并；
- 无法合并时创建冲突快照，不在原文件上静默覆盖；
- 思源文档、Markdown 和资源文件的转换必须在 `ContentAdapter` 中显式处理，并以 fixture 测试锁定行为。

### 7.6 冲突暂停与用户决策

冲突出现后：

```text
保存 SyncContext
↓
保存每个冲突的 base/local/remote 快照引用
↓
状态改为 CONFLICT_PAUSED
↓
停止对应仓库分支的自动同步任务
↓
显示冲突数量、路径和可执行动作
```

支持操作：

- 逐文件编辑并标记已解决；
- 接受本地版本；
- 接受远端版本；
- 导出三方副本；
- 稍后处理；
- 放弃本轮并恢复到新的只读诊断。

“接受本地”或“接受远端”不是无条件强制覆盖：必须基于重新读取的远端 HEAD 创建新的同步计划，再执行安全提交。

### 7.7 提交与 Push

提交前规则：

1. 只有计划中存在远端变更时才创建 Blob、Tree、Commit；
2. 无变化时标记成功但不创建 Commit；
3. 单次逻辑同步优先一个 Commit；
4. 超出 API 限制时按确定性阈值拆分；
5. 每个批次使用同一 `operationId`；
6. 每批次提交信息可追踪且可读。

提交信息格式：

```text
sync: <操作摘要> [<operationId>]
```

拆分时：

```text
sync: update 432 files [sync-20260902-001 part 1/3]
```

Push 成功判定：

```text
updateRef 返回成功
且
回读 branch HEAD === 本轮最后一个 commit SHA
```

只有满足上述条件，才能：

```text
更新 lastConfirmedCommit
记录 lastSuccessfulAt
写入 SUCCESS 历史
通知同步成功
```

### 7.8 远端变化与重试

可自动重试的前提：

- 本轮尚未对远端成功写入；
- 错误为网络暂态、超时或远端 HEAD 已变化；
- 重试次数未超过上限；
- 本地快照仍可用；
- 不存在未解决冲突。

策略：

```text
NETWORK / TIMEOUT
  最多 3 次
  延迟：1s、3s、9s，并加入小幅随机抖动

REMOTE_CHANGED / PUSH_REJECTED
  最多 2 次
  每次重新读取远端 HEAD、重新计算计划、重新合并

AUTH / PERMISSION / REPOSITORY / BRANCH / LARGE_FILE / CONFLICT
  不自动重试
```

重试不得复用旧的 tree 或 commit 作为新的远端基准。

## 8. SyncQueue 与幂等性

队列键：

```text
<provider>:<owner>/<repo>:<branch>
```

规则：

1. 同一键同一时刻只运行一个同步任务。
2. 自动同步触发时，若已有任务运行，只记录“已合并触发”，不创建并行任务。
3. 手动同步可选择“加入当前任务并查看进度”或“在当前任务结束后重新规划”；默认不并发执行。
4. 冲突解决操作必须持有同一队列键。
5. 不同仓库分支可并行，但 UI 和存储记录必须区分 `operationId`。
6. 每个远端写入请求携带操作上下文，便于日志关联。

幂等性规则：

- `get*` 和 compare 操作可安全重试；
- `createBlob` 可通过内容哈希去重；
- `createCommit` 失败后不可仅根据本地变量判断成功，必须回读远端引用；
- `updateRef` 的成功必须回读确认；
- 历史记录写入使用 `operationId` 去重。

## 9. 错误、日志与通知

### 9.1 持久化历史

每个操作记录：

```js
{
  id,
  trigger,
  startedAt,
  finishedAt,
  state,
  phase,
  baseCommit,
  expectedRemoteHead,
  result,
  error,
  conflictCount
}
```

保留最近 100 次，按仓库分支隔离。日志和历史文件均不进入同步范围。

### 9.2 通知策略

| 场景 | UI 行为 |
|---|---|
| 同步排队或执行中 | 顶栏状态和可展开进度 |
| 成功且有变更 | 简洁成功提示和摘要 |
| 成功且无变更 | 状态更新，不反复 Toast |
| 网络可重试失败 | 显示重试状态和下次时间 |
| 认证、权限、仓库错误 | 明确操作建议，禁止自动重试 |
| 冲突 | 持久化通知、冲突列表和处理入口 |
| 基准无法恢复 | 阻止写入，展示导出和恢复向导 |
| 大文件 | 展示路径、实际大小、平台限制和可选处理 |

错误详情页面只显示脱敏信息。Token、Authorization、Cookie、SSH 私钥和完整远端 URL 中的敏感参数必须隐藏。

## 10. 分阶段实施计划

### 阶段 0：冻结旧注入路径并建立新工程骨架

**目标**：不再扩展 patch；建立可独立构建的新插件源码。

**新增范围**：

```text
package.json
src/plugin/
src/sync/
src/git/
src/local/
src/storage/
src/ui/
tests/
```

**完成条件**：

- 新入口可被思源加载；
- 不引用 `patch/` 或 `vendor/`；
- 读取旧配置但不写入远端；
- 可执行 lint、单元测试和构建；
- 发布一个不含同步写入的新架构预览包。

**风险控制**：新插件使用新的目录名和独立元数据，不能覆盖运行中的旧插件。

### 阶段 1：只读诊断与元数据迁移

**目标**：验证配置、远端可达性、分支、旧基准和本地扫描，不写远端。

**实现范围**：

```text
SyncContext
SyncError
SyncHistoryStore
SyncMetadataStore
GitProvider.getBranchHead/getCommit/getTree
LocalWorkspaceAdapter
诊断 UI
```

**完成条件**：

- 能明确分类配置、网络、认证、权限、仓库、分支和本地文件错误；
- 能读取旧 `lastSyncCommit`，但不错误迁移为确认基准；
- 能展示本地、远端、BASE 是否可用；
- 所有诊断 API 有 mock 测试。

### 阶段 2：安全下载和本地预览

**目标**：实现远端领先但本地未改动时的安全拉取，不写远端。

**实现范围**：

```text
SyncPlanner
远端文件读取
本地快照
隔离预览目录
远端领先应用策略
```

**完成条件**：

- 不覆盖本地独立修改；
- 应用前可预览文件列表和差异；
- 应用失败可从快照恢复；
- 覆盖新增、修改、删除和忽略规则测试。

### 阶段 3：安全上传和 GitHub 原子提交

**目标**：实现本地领先时的 GitHub 安全写入。

**实现范围**：

```text
GitHubProvider.createBlob/createTree/createCommit/updateBranchRef
CommitBuilder
远端 HEAD 二次确认
Push 回读确认
SyncQueue
```

**完成条件**：

- 无变化不提交；
- Push 成功后才更新 `lastConfirmedCommit`；
- 远端变化时不覆盖，重新规划；
- 409、422、网络中断和重复触发均有测试；
- 每次提交可关联 `operationId`。

### 阶段 4：双向同步、三方合并与冲突中心

**目标**：实现完整的 BASE/LOCAL/REMOTE 决策、内容级三方合并和持久化冲突处理。

**实现范围**：

```text
ThreeWayMerger
ConflictService
多文件冲突存储
冲突 UI
基准失效恢复向导
```

**完成条件**：

- 覆盖新增、修改、删除、双方修改和双方删除场景；
- 文本自动合并可重复且确定；
- 不可合并内容不自动覆盖；
- 多冲突文件可逐项处理；
- BASE 不存在时阻止写入并提供恢复流程。

### 阶段 5：Gitee Provider 与能力差异处理

**目标**：在不降低数据安全的前提下支持 Gitee。

**完成条件**：

- 实现与 `GitProvider` 相同的查询能力；
- 写入路径具备明确原子性说明；
- 非原子写入具备操作日志、部分失败状态和恢复向导；
- GitHub 与 Gitee 的能力差异在 UI 和文档中明示；
- 同一套 Planner、Merger、Queue 测试可复用。

### 阶段 6：迁移发布与旧路径移除

**目标**：完成从旧 SGSP 到新引擎的可逆迁移。

**完成条件**：

- 连续多个版本通过集成测试和真实测试仓库验证；
- 发布迁移向导、数据备份指引和回滚说明；
- 新版本不再执行 `patch/apply-patch.mjs`；
- CI 不再将 `vendor/index.js` 作为构建输入；
- `patch/` 和 `vendor/` 从主分支移除或归档到独立迁移分支；
- 旧版安装包保留固定期限，供用户回退。

## 11. 测试与验收

### 11.1 单元测试

必须覆盖：

- SyncState 合法和非法转换；
- SyncQueue 去重、排队和取消；
- SyncError 分类、脱敏和重试资格；
- BASE 解析和丢失处理；
- Planner 的全部三方文件状态组合；
- 文本合并、二进制文件和大文件处理；
- 提交消息分批；
- 元数据写入失败；
- 历史去重和上限；
- 旧配置迁移。

### 11.2 Provider 合约测试

对 GitHub 和 Gitee 使用同一组 Provider 合约测试：

- 分支 HEAD 读取；
- Commit 和 Tree 读取；
- 不存在仓库或分支；
- 无效 Token；
- 权限不足；
- 网络超时；
- 远端 HEAD 竞争；
- `updateRef` 失败；
- 成功后回读验证。

### 11.3 集成测试

使用独立测试仓库或高保真 HTTP mock，覆盖：

1. 初次同步；
2. 本地领先；
3. 远端领先；
4. 双方修改不同文件；
5. 双方修改同一文本文件且可自动合并；
6. 双方修改同一文本文件且冲突；
7. 本地删除与远端修改；
8. 远端删除与本地修改；
9. Push 期间远端变化；
10. BASE 提交已不可访问；
11. 网络中断后重试；
12. 重启后恢复冲突和同步历史；
13. 大文件限制；
14. 自动同步与手动同步并发；
15. GitHub 和 Gitee 的能力差异。

### 11.4 人工验收

真实思源环境中至少验证：

- 三台设备同仓库交替同步；
- 同一文档同时修改；
- 思源格式与 Markdown 模式；
- 资源文件、忽略规则和删除；
- 自动同步、手动同步、完全手动；
- Token 失效、权限收回、仓库改名；
- 应用关闭或网络中断后恢复；
- 升级、迁移和回滚。

### 11.5 发布门槛

满足以下条件前不得默认启用新引擎的双向写入：

- 全部单元测试和 Provider 合约测试通过；
- GitHub 集成测试通过；
- Gitee 若已启用写入，则对应集成测试通过；
- 无变化同步不生成 Commit；
- Push 竞争测试证明不静默覆盖远端；
- BASE 丢失测试证明不错误更新确认基准；
- 冲突测试证明暂停状态、快照和恢复可用；
- 安全审查确认日志与历史不泄露凭据；
- 至少完成一次真实仓库灰度验证和回滚演练。

## 12. 灰度与回滚

### 12.1 灰度策略

1. 新引擎默认只读诊断。
2. 用户显式启用“新同步引擎预览”后才允许写入。
3. 首次写入前自动生成本地快照，并显示同步计划预览。
4. 首次双向同步先限制到测试仓库或用户确认的分支。
5. 按功能开关分阶段开放：只读、下载、GitHub 上传、双向合并、Gitee 上传。
6. 每个阶段收集脱敏诊断数据时必须取得用户明确同意；默认仅保存在本地。

### 12.2 回滚策略

回滚不是把远端仓库强制还原到旧状态，而是：

1. 停止新引擎自动同步；
2. 保留最近一次成功的 `SyncContext`、本地快照和远端 HEAD；
3. 导出本地未同步修改和冲突副本；
4. 允许用户安装旧版插件包；
5. 旧版只在用户确认基准一致后恢复自动同步；
6. 基准不一致时提示先在新引擎诊断页完成恢复，而不是直接运行旧同步逻辑。

## 13. 明确不做的事项

在 Sync Engine 2.0 稳定前，不做以下范围扩张：

- 自动重写远端仓库目录结构；
- 自动生成面向 GitHub 展示的 Markdown 副本；
- Git LFS 自动配置；
- 多仓库镜像；
- 云端账号托管；
- 未经用户确认的远端强制覆盖；
- 未经测试覆盖的 Gitee 写入兼容层。

这些功能可在同步正确性和恢复能力稳定后单独评估。

## 14. 最终实施原则

新引擎的核心不是“更快地 Push”，而是以下不变量：

```text
未确认远端状态，不写入
未确认同步成功，不更新 BASE
无法自动合并，不自动覆盖
写入失败，不伪造成功
错误可分类、可追踪、可恢复
新功能不依赖 patch 或压缩 bundle
```

只要上述不变量被接口、测试、发布门槛和回滚流程共同约束，SGSP 才能从“在原 bundle 上增加冲突处理”升级为可长期维护的同步产品。
