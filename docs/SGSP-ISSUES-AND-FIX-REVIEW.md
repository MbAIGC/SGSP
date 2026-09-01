# SGSP 问题复盘与修复方案

## 1. 文档目的

本文记录 SGSP 在重构、改名和发布过程中发现的问题、根因、修复思路、验证结果与发布方式，作为后续维护和排查的依据。

SGSP 当前维护者为 `MbAIGC`。项目 Fork 自原作者 `xstarling` 的插件：

- 原作者：<https://github.com/xstarling>
- 原项目：<https://github.com/xstarling/sy-git-sync-plugin>
- 改名原因：为避免与原插件使用相同的插件标识、安装目录和仓库名称，Fork 后统一改名为 `SGSP`。

感谢并致敬原作者在同步基线、三方合并、冲突检测、历史记录和回滚机制方面的设计与实现。

## 2. 问题一：冲突后自动同步没有暂停

### 2.1 原始现象

原插件检测到冲突后只显示一次短时通知，自动同步定时器仍然继续运行。后续每次定时同步都会再次触发冲突、再次记录错误，用户无法判断当前同步是否已经暂停或应该如何处理。

### 2.2 根因

原插件的三个同步入口使用了会吞掉异常的装饰器：

```js
we({ rethrow: false })
```

冲突错误在到达 SGSP 状态机前已经被原异常处理器消费，补丁层无法可靠判断 `code === 300` 的冲突错误。

### 2.3 正确修复方式

不修改原插件的同步和合并算法，只在补丁生成阶段将以下三个同步入口改为异常继续传播：

- `handleRemoteCoverLocal`
- `handleLocalCoverRemote`
- `handleAutoRemoteAndLocalFileSync`

随后由 `src/sync-flow-runtime.js` 统一处理错误链，在最多 7 层 `cause` 链中查找冲突错误码 `300`。

冲突状态机流程为：

```text
发现冲突
  ↓
CONFLICT_PAUSED
  ↓
暂停自动同步定时器
  ↓
顶栏红色徽标 + 前端通知
  ↓
用户选择处理方式
  ↓
强制保留本地或远端版本
  ↓
恢复自动同步
```

### 2.4 关键设计

- 自动同步触发时使用 `autoTick` 标记，暂停期间静默拦截重复触发。
- 用户手动点击同步时重新打开冲突处理对话框。
- 选择保留本地版本时调用强制本地覆盖远端。
- 选择保留远端版本时调用强制远端覆盖本地。
- 冲突暂停状态持久化，重启思源后继续保持暂停。
- 旧版状态文件名 `git-sync-flow.json` 保持不变，避免升级时丢失已有暂停状态。

## 3. 问题二：同步历史面板出现 `null.childNodes`

### 3.1 错误现象

日志示例：

```text
TypeError: Cannot read properties of null (reading 'childNodes')
    at initGitGraph
    at openSyncHistoryPanel
```

调用链表明，用户打开同步历史时，Git Graph 组件初始化失败。

### 3.2 根因

原插件的 `openSyncHistoryPanel()` 执行顺序如下：

1. 创建 `q.Dialog`；
2. 立即执行 `t.element.querySelector("#syncHistory")`；
3. 将查询结果作为 Svelte 组件的 `target`；
4. Git Graph 初始化时读取目标节点的 `childNodes`。

在部分前端时序下，Dialog 的内容节点还没有完成挂载，查询结果为 `null`。原始组件内部没有对 `target` 做空值检查，于是产生 `null.childNodes` 异常。

### 3.3 正确修复方式

在 `patch/apply-patch.mjs` 中对 `openSyncHistoryPanel()` 做最小包装：

- 创建 Dialog 后显式检查 `t.element`、`querySelector` 和 `#syncHistory`；
- 挂载节点不存在时不创建 Git Graph 组件；
- 将具体原因写入 SGSP 前端运行日志；
- 通过 `q.showMessage()` 显示用户可理解的错误提示；
- 其他异常同样转换为前端提示，不让错误只停留在服务端日志中。

这种方式比修改原始 Git Graph 组件更合适，因为它只保护外部挂载边界，不改变原插件的历史数据查询和图表渲染逻辑。

## 4. 问题三：错误只写服务端日志，前端不可见

### 4.1 原始问题

部分错误通过服务端日志记录，例如：

```text
[ERROR] [plugin:SGSP] initGitGraph: ...
```

但用户在插件界面看不到任何错误，只能登录服务器或检查日志文件，排查成本过高。

### 4.2 正确修复方式

SGSP 增加轻量级前端运行日志机制：

- 日志由状态机统一写入；
- 每条日志包含时间、级别和消息；
- 最多保留最近 200 条，避免无限增长；
- 日志内容先进行 HTML 转义，再放入 Dialog，避免日志内容破坏界面；
- 顶栏插件菜单增加“SGSP 运行日志”入口；
- 同步失败、冲突、冲突解决失败、历史面板异常和恢复异常都写入日志；
- 错误同时通过前端 `showMessage` 显示；
- Token、密码和仓库凭据不写入运行日志。

服务端日志仍然保留，用于开发者定位堆栈；前端运行日志用于用户查看最近运行结果。两者职责不同，不能互相完全替代。

## 5. 问题四：插件与原插件重名

### 5.1 风险

如果 Fork 后继续使用原插件标识，可能产生以下问题：

- 思源插件目录冲突；
- 原插件与 SGSP 互相覆盖；
- 用户无法明确区分来源和维护者；
- GitHub 仓库、Release 和安装包名称容易混淆；
- 同步排除规则可能继续指向旧插件目录。

### 5.2 统一改名结果

以下标识统一为 `SGSP`：

- 插件 `name`：`SGSP`；
- 中英文显示名：`SGSP`；
- 作者：`MbAIGC`；
- 思源安装目录：`data/plugins/SGSP/`；
- 插件自身数据目录：`data/storage/petal/SGSP/`；
- 临时备份目录：`temp/SGSP/backup/`；
- CI 安装包：`SGSP-<版本>.zip`；
- GitHub 仓库：<https://github.com/MbAIGC/SGSP>。

`vendor/index.js` 和 `vendor/index.beautified.js` 继续保留原始 bundle 基线，作为可审计输入，不直接修改。构建时只修改生成产物中的插件自身排除路径。

## 6. README 默认语言调整

为方便中文用户直接阅读，插件元数据现在使用：

```json
{
  "readme": {
    "zh_CN": "README.md",
    "en_US": "README_en_US.md"
  }
}
```

其中：

- `README.md`：中文主文档；
- `README_en_US.md`：英文文档；
- 两个 README 互相链接；
- README 说明 SGSP 的改名原因、维护者、原作者和原项目地址。

## 7. 构建与发布方案

### 7.1 构建原则

构建输入和输出明确分离：

```text
vendor/index.js             原插件 bundle，只读输入
src/sync-flow-runtime.js    SGSP 新增逻辑源码
patch/apply-patch.mjs       注入与构建脚本
index.js                    最终插件 JavaScript 产物
根目录其他文件              可安装插件包文件
```

执行构建：

```bash
GIT_SYNC_VERSION=0.3.1 node patch/apply-patch.mjs
```

构建脚本具备以下保护：

- 检查原始 bundle 注入锚点是否唯一；
- 检查 `vendor/index.js` 是否已经被重复注入；
- 写入产物前执行 JavaScript 语法检查；
- 从官方原始 bundle 重新生成，确保重复执行结果稳定。

### 7.2 可安装 Release 包

Release 包必须直接包含思源插件目录所需的文件，而不是把整个源码仓库压缩进去。`SGSP-0.3.1.zip` 包含：

```text
index.js
index.css
plugin.json
i18n/en_US.json
i18n/zh_CN.json
icon.png
preview.png
README.md
README_en_US.md
```

解压后可直接将这些文件放入：

```text
data/plugins/SGSP/
```

GitHub Actions 在构建时执行相同的打包清单，并在推送 `v*` 标签时将 ZIP 上传到 GitHub Release。

## 8. 验证清单

本次修复完成后执行了以下验证：

- 15 项同步状态机单元测试全部通过；
- `node --check index.js` 通过；
- `node --check patch/apply-patch.mjs` 通过；
- 端到端冲突闭环冒烟验证通过；
- 冒烟验证确认插件标识为 `SGSP`；
- 冒烟验证确认三个同步入口继续传播异常；
- `git diff --check` 通过；
- `SGSP-0.3.1.zip` ZIP 完整性校验通过；
- GitHub `v0.3.1` Release 已发布。

## 9. 后续维护要求

1. 不要直接修改 `vendor/index.js`，原始 bundle 应作为补丁输入基线保留。
2. 新增运行行为时优先接入前端运行日志和前端通知，避免只写服务端日志。
3. 修改注入点后必须重新运行单元测试、构建、语法检查和冒烟验证。
4. 修改 `plugin.json` 的插件标识、README 映射或安装目录时，要同步检查 CI 打包清单。
5. 涉及冲突状态持久化时，必须考虑旧版本升级兼容，避免清空用户已有状态。
6. Release 上传的 ZIP 必须是解压即可安装的插件包，不能要求用户从源码目录中自行挑选文件。
