# SGSP 两项问题分析与解决方案

> 本文记录本次问题分析、已实施的修复以及后续建议。

## 一、查看日志功能无效

### 1. 现象

用户点击“SGSP 运行日志”后，无法看到实际运行错误，尤其看不到类似下面的原插件异常：

```text
[plugin:SGSP] ERROR [Fe] 创建文件提交树失败
```

### 2. 已确认的实现现状

当前运行日志实现位于 `src/sync-flow-runtime.js` 的 `createSyncFlowHost()`：

- `logEntries` 是宿主创建时初始化的内存数组；
- `addLog()` 只保存显式调用它的内容，最多保留 200 条；
- `notify()` 会把 SGSP 自己发出的通知写入数组；
- `showRuntimeLogs()` 只读取这个数组并创建 `q.Dialog`；
- 日志没有持久化，插件重载或重新创建宿主后会清空；
- 日志没有接管原插件的 `S.info`、`S.error`、`saveToLogger()` 或全局异常处理器；
- 原插件 `handleGitAPIError()` 仍只调用 `saveToLogger()`，因此原插件错误不会自动进入 `logEntries`。

因此“查看日志无效”的核心原因不是日志列表渲染本身，而是日志数据源设计不完整：当前查看器只查看 SGSP 状态机日志，不是整个插件运行日志。

### 3. 还存在的潜在入口问题

菜单入口由 `patch/apply-patch.mjs` 注入到原插件 `openMenuPanel()`。如果点击后完全没有弹窗，应额外检查：

1. 当前思源实际加载的 `index.js` 是否是最新构建产物；
2. 是否重启了插件或思源，而不是只刷新了源码目录；
3. 当前前端的 `q.Dialog` 是否接受 `title/content/width/height` 这些参数；
4. `q.Menu.addItem()` 是否允许使用 `iconInfo`，以及菜单项是否确实出现在当前前端菜单；
5. `host.showRuntimeLogs` 是否存在，点击回调是否捕获异常。

正确的实现必须在菜单回调中检查宿主方法，并在调用失败时通过 `q.showMessage()` 告知用户，而不能只依赖控制台或服务器日志。

### 4. 推荐解决方案

#### 方案 A：建立统一、可验证的日志入口

在 SGSP 运行时增加统一的 `recordLog(level, message, details)`，所有 SGSP 新增逻辑都通过它记录。方法应满足：

- `level` 至少支持 `info`、`warn`、`error`；
- 消息和结构化详情分开保存；
- 限制单条消息长度和总条数；
- 统一脱敏，删除 token、密码、Authorization、Cookie、仓库凭据和完整请求体；
- 前端 Dialog 展示纯文本或经过 HTML 转义的内容；
- 增加“清空日志”和“复制/导出脱敏日志”按钮时，应明确提示导出内容不含凭据。

#### 方案 B：接入原插件的异常链

最可靠的接入点是 SGSP 已经包裹的同步入口：

```text
syncDataToCloud()
  -> runSync()
  -> __gSyncDataToCloudBase()
  -> 原插件同步逻辑
  -> 原插件异常处理器
```

在 `runSync()` 的 `catch` 中，不能只读取 `err.message`，应提取：

- 最外层异常类型和消息；
- `code`；
- `path`；
- `cause` 链中最底层的 API 错误；
- HTTP status、response.data.message、request path 等非敏感摘要。

然后调用 `recordLog("error", ...)`，再按错误类型显示简洁的前端通知。

对于原插件在同步入口之外直接调用全局异常处理器的错误，建议在补丁层增加受控的错误转发，而不是粗暴重写全局 `S.error`。重写全局日志函数容易破坏原插件和思源内核的日志行为。

#### 方案 C：让查看器本身可诊断

`showRuntimeLogs()` 应具备以下保护：

```text
检查宿主存在
  -> 检查 q.Dialog 是否可用
  -> 创建对话框
  -> 成功后写入一条 info 日志
  -> 失败时写入 error，并调用 q.showMessage
```

此外，日志查看器不应通过内存数组的直接引用渲染，应该先复制快照，避免渲染过程中数组变化造成异常。

#### 方案 D：考虑持久化，但不要持久化敏感内容

如果目标是查看“上一次同步”的失败，纯内存数组不够。可以持久化最近 50 至 100 条脱敏摘要，使用独立数据文件，例如：

```text
sgsp-runtime-log.json
```

但不建议保存完整异常对象、完整 request、base64 文件内容或远端响应原文。持久化内容只应包括时间、级别、错误分类、文件路径摘要和用户可理解的错误信息。

### 5. 不建议的方案

- 只把 `console.error` 改成 `S.error`：用户仍然看不到，且没有进入查看器。
- 全局 monkey patch `console.log`：噪声大、性能差，并可能收集敏感数据。
- 全局 monkey patch `S.error`：会影响思源和原插件所有日志，升级兼容性差。
- 把 GitHub 请求完整对象直接放进前端 Dialog：可能泄露 token、请求体和二进制内容。
- 只增加菜单文字，不测试菜单点击后的 Dialog 创建结果：无法证明功能有效。

## 二、字体文件同步失败：`CODE: 107`

### 1. 现象

错误涉及文件：

```text
conf/appearance/fonts/LxgwWenKai-Lite-1.501/LXGWWenKaiLite-Regular.ttf
```

文件大小约为 `11,676,424` 字节，原插件记录：

```text
[Fe] 创建文件提交树失败
CODE: 107
```

请求体包含：

```json
{
  "mode": "100644",
  "type": "blob",
  "sha": "",
  "size": 11676424,
  "encoding": "base64"
}
```

### 2. 已确认的代码路径

原插件 `addFileToWorkArea()`：

1. 检查单文件大小是否超过内部限制 `xi`；
2. 调用 `octokit.rest.git.createBlob()`；
3. 把文件内容转换为 Base64；
4. 将 Blob SHA 写入待提交 tree；
5. 后续调用 `git.createTree()`、`git.createCommit()` 和 `git.updateRef()`。

内部枚举中：

```text
ne.GIT_BLOB = 107
```

所以 `107` 是插件内部的错误分类 `GIT_BLOB`，不是 GitHub HTTP 状态码，也不能单独证明是权限、文件损坏或仓库冲突。

### 3. 最可能的根因

该错误发生在 GitHub Git Database API 的 `POST /repos/{owner}/{repo}/git/blobs` 阶段。文件原始大小约 11.7 MB，Base64 后约 15.6 MB，还要经过 JSON 编码和 HTTP 传输。

最可能原因按优先级排序：

1. GitHub Git Blobs API 对该请求体或单个 Blob 的限制被触发；
2. 代理、网关或网络层拒绝了较大的 Base64 JSON 请求；
3. Octokit 返回了错误，但原插件 catch 只重新包装为 `GIT_BLOB=107`，丢失了实际 HTTP status 和 response message；
4. 文件读取得到的 `content` 不完整或 encoding 与内容不匹配；
5. Token 权限或仓库策略异常，可能性低于大文件请求限制，但必须查看底层 response 才能排除。

日志中的 `response: null`、`error: null` 不能证明服务端没有返回错误，因为原插件的异常包装和保存日志方式可能没有保留底层异常字段。

### 4. 正确解决方案

#### 方案 A：默认排除不适合 Git 同步的资源目录

最推荐的产品级方案是不要把思源运行环境中的大字体、主题缓存、插件包和其他二进制资源默认纳入普通笔记同步。

建议增加可配置排除规则，至少支持：

```text
conf/appearance/fonts/
conf/appearance/icons/
data/assets/
```

具体目录必须以用户的同步范围和实际数据结构为准，不能无条件删除或忽略已有用户文件。首次检测到超大文件时，应显示文件路径、大小和“跳过本次/加入排除规则/继续尝试”选项。

#### 方案 B：加入文件大小和 Base64 大小的预检查

不能只检查原始文件大小，还应检查编码后的请求规模：

```text
rawBytes = 文件原始字节数
base64Bytes ≈ ceil(rawBytes / 3) * 4
jsonBytes = base64Bytes + 请求字段开销
```

超过安全阈值时，在本地直接阻止本次上传，并显示明确提示：

```text
文件约 11.7 MB，Git Blob API 上传风险较高，请将该文件加入排除规则，
或改用 Git LFS / 外部资源存储。
```

阈值应保守配置并可调整，不能把 GitHub 的服务端限制硬编码成未经验证的绝对值。

#### 方案 C：保留底层错误信息

修改错误包装时必须保留：

- `status`；
- `response.data.message`；
- `response.data.errors`；
- 请求 URL 或 endpoint 名称；
- 文件原始大小和编码后估算大小。

但前端日志只显示脱敏摘要，例如：

```text
上传 Git Blob 失败：HTTP 413，文件 11.7 MB，路径 conf/appearance/fonts/...
```

详细 response 可以写开发者日志，但不得把 Authorization、请求中的 base64 content 或 token 放入日志。

#### 方案 D：大文件确实需要版本控制时使用 Git LFS

如果用户确实需要同步字体等大文件，正确的 Git 方案是 Git LFS，而不是继续把完整 Base64 内容塞进 Git Blobs API。需要评估：

- GitHub/Gitee 是否都支持目标仓库的 LFS；
- 用户的凭据是否有 LFS 权限；
- SiYuan 插件是否具备调用 Git LFS 客户端的能力；
- 移动端、浏览器端和 Docker 环境是否都能稳定使用；
- Release 包和普通笔记同步是否应采用不同存储策略。

如果插件当前不具备 LFS 能力，不应伪装成支持；应明确提示用户排除该文件或使用外部同步工具。

### 5. 不建议的方案

- 只把内部错误码 `107` 改成更大的数字：不会解决上传失败。
- 只增大 `xi` 文件大小上限：会让更多请求进入必然失败的 API 链路。
- 把 11.7 MB 文件切成多个普通 Git Blob：Git Blob 必须对应完整文件，分片不能被 Git tree 直接还原为一个文件。
- 重试同一个超大请求：如果是大小限制，重试只会产生噪声和额外等待。
- 把整个二进制文件内容写入前端运行日志：会导致内存、界面和隐私问题。
- 未确认服务端响应就断言一定是 GitHub 限制：应先保留 HTTP status 和 response message，再做最终归因。

## 三、推荐实施优先级

### P0：先恢复可诊断性

1. 修复日志菜单点击后的异常反馈；
2. 确认查看器能显示至少一条自测日志；
3. 在 `runSync()` 错误链中记录脱敏错误摘要；
4. 在 Git Blob 失败时保留底层 HTTP status 和 response message；
5. 禁止记录 token、Authorization、Cookie 和 base64 文件内容。

### P1：避免大文件再次触发失败

1. 增加原始大小和 Base64 大小预检查；
2. 对字体、资源和缓存目录提供可配置排除；
3. 对超限文件提供明确的跳过和加入排除规则选项；
4. 对单个失败文件给出路径、大小和失败原因。

### P2：扩展能力

仅在明确产品需求后评估：

- Git LFS；
- 远端对象存储；
- 失败队列和断点续传；
- 跨设备持久化运行日志；
- 针对 GitHub、Gitee 的不同文件限制策略。

## 四、结论

1. “查看日志无效”主要是数据源覆盖范围不足：当前查看器只显示 SGSP 状态机日志，没有接入原插件全局异常和 Git API 错误。
2. `CODE: 107` 明确表示原插件内部的 `GIT_BLOB` 分类，不是服务端 HTTP 状态码。
3. 11.7 MB 字体通过 Base64 上传到 Git Blob API，最可能触发请求大小或平台限制；但必须保留底层 response 才能最终确认。
4. 最正确的修复顺序是：先增强错误可观测性，再增加大文件预检查和排除规则；只有确有需求时才评估 Git LFS。
5. 不应直接修改官方 `vendor/index.js` 的核心算法。优先在 SGSP 补丁层和运行时状态机增加边界保护、错误转发、脱敏日志和用户提示。
