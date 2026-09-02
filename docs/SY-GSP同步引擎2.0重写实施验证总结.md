# SY-GSP 同步引擎 2.0 重写实施验证总结

## 一、任务目标

按《SGSP同步引擎2.0可落地实施方案》对插件进行**完全重写**：

1. 旧版源码整体归档至 `SGSP-V1/`，仓库根目录作为新插件（`SY-GSP`）源码；
2. UI 与交互对齐旧版（设置面板、顶栏、冲突对话框、同步历史、诊断面板）；
3. 实现同步引擎 2.0 的全部安全不变量，代码逻辑清晰、干净、整洁；
4. 单元测试、构建、冒烟验证全链路通过。

## 二、架构与实现范围

### 分层结构（src/，共 35 个源文件）

| 层 | 模块 | 职责 |
| --- | --- | --- |
| plugin | index.js / menu.js / repo-address.js | 插件生命周期、菜单与命令、仓库地址解析 |
| sync | sync-controller / sync-engine / sync-planner / three-way-merger / commit-builder / conflict-service / sync-queue / retry-policy / sync-context / sync-error | 控制器-引擎两级编排、规划、三方合并、提交构建、冲突持久化、串行队列、错误分类与有限重试 |
| git | http-client / git-provider / github-provider / gitee-provider | HTTP 客户端、Provider 抽象、GitHub 原子树提交 + CAS、Gitee 逐文件 Contents API |
| local | kernel / workspace-adapter / ignore-rules / content-adapter | 内核 API 封装、工作空间扫描与删除守卫、忽略规则、思源/Markdown 内容适配 |
| storage | sync-metadata-store / sync-history-store / local-manifest-store / migration | 确认基准元数据、同步历史、本地清单、旧版配置迁移 |
| ui | settings-panel / settings-builder / conflict-dialog / diagnosis-panel / runtime-logs / sync-history-panel / notification-service | SettingUtils 移植与设置项装配、冲突对话框、诊断/历史面板、通知 |

### 安全不变量落实

1. **无确认不写入**：FETCHING 阶段必须取得远端头（空仓库走 headless 模式并 `ensureBranchRef` 显式创建引用）；规划基于「BASE / 远端 / 本地」三态矩阵。
2. **无确认不更新基准**：`setConfirmedCommit` 仅在推送返回可确认 commit 后调用；GitHub 取树提交结果，Gitee 取最后一个操作返回的 commitSha。
3. **冲突不自动覆盖**：三方合并冲突进入 `conflict-service`（快照截断持久化），自动同步暂停并写入 `engine-state.json`；解决后恢复。
4. **不伪造成功**：`batches>0` 而无法确认最终提交 → 抛 `PUSH_UNCONFIRMED`；所有错误经 `SyncError` 分类（NETWORK/TIMEOUT/REMOTE_CHANGED/PUSH_REJECTED/AUTH/…）。
5. **删除多重守卫**：基准存在 + 清单存在 + 同步范围校验，任一不满足则跳过并计数（`skippedDeletes`）。
6. **首同步向导**：无基准时先只读诊断 + 计划预览，确认方向后才首次写入；`BASE_UNRESOLVED` 进入恢复向导。

## 三、本轮问题与解决思路

| 问题 | 根因 | 解决 |
| --- | --- | --- |
| `node --test tests/` 目录形式失败 | Node 22 对目录入参的处理与预期不符 | 测试脚本改为带引号 glob `node --test "tests/*.test.mjs"` |
| 引擎测试 `ensureBranchRef is not a function` | 测试替身 provider 是普通对象，未继承基类 | `Object.setPrototypeOf(provider, GitProvider.prototype)` 复用真实基类契约 |
| 冲突快照「截断」断言失败 | 测试把 snapshots 放在顶层，而非冲突项内；且误读 `store.data` | 修正测试数据形状与读取路径（`store.sets`） |
| 元数据 legacyHint 断言失败 | legacyHint 存于 `data.legacyHints[repoKey]`，不在仓库条目内 | 新增 `getLegacyHint(repoKey)` 访问器，测试与诊断面板改用该接口 |
| 历史/重试/错误分类等断言偏差 | 测试与实现契约不一致（历史尾部追加、SyncError 优先采用链上最具体消息、redact 模式过窄） | 以实现契约为准修正测试；`redact` 补充 token/Authorization/Cookie 变体模式 |
| 队列测试死锁（事件循环耗尽） | 合并判定依赖 `_run` 微任务里的 `running` 标志，入队瞬间尚未置位 | `enqueue` 同步维护 `pending` 计数，合并判定 `running || pending>0`，不再受微任务时序影响 |
| 规划器「双方同时新增」误判 | 无基准时本地状态被算作 `changed` | `_localState` 无基准一律返回 `new`，按「双方同时新增 → 冲突」处理 |
| 迁移在无旧版数据时仍写入强制键 | 强制键（平台选择）无条件写入 | 新旧文件均缺失时直接返回空报告，不做任何写入 |
| 冒烟 `document is not defined` | 设置面板/顶栏在无头环境构建 DOM | 冒烟脚本补最小 DOM/fetch 存根 |
| `syncNow` 配置缺失未打开设置 | `openSetting` 读取了不存在的 `this.plugin.setting` | 改读 `this.setting`（SettingUtils 挂载约定） |
| 设置项保存值从未生效 | `build()` 在 `addItem` 之前 `load()`，此时 settings Map 为空 | 重构为「先注册全部项 → `load()` 覆盖 → 平台文件覆盖 → 刷新基准展示」 |
| `CHECKING -> CHECKING` 非法状态转换 | 控制器抢先改写 ctx 状态 | 状态机由引擎推进，控制器仅镜像展示状态 |
| `readDir` 返回值不可迭代 | 内核 `fetchSyncPost` 未解包 `data`，且 readDir 响应为 `{dir,file}` | `kernel.post` 统一解包并校验 code；`readDir` 归一化为条目数组 |

## 四、验证结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm test`（node --test "tests/*.test.mjs"） | **100/100 通过**，0 失败 0 取消 |
| 构建 | `npm run build`（esbuild → index.js，CJS，external siyuan） | 213 KB / 35 个源文件，CJS default 导出校验通过 |
| 冒烟验证 | `npm run smoke`（siyuan/DOM/fetch 存根装载构建产物） | 7/7 通过：入口导出、onload 装配、顶栏注册、配置缺失安全路径、引擎链路错误分类、onunload 清理 |
| 全链路 | `npm run verify`（test + build + smoke） | 全部通过 |

测试覆盖：错误分类与脱敏、同步上下文/队列/重试、忽略规则与地址解析、三方合并、规划矩阵、提交构建分批、双平台 Provider（fetch 录制回放）、元数据/历史/清单存储、旧版迁移、引擎端到端（本地领先/远端领先/自动合并/冲突暂停/空仓库首推/推送竞争/REMOTE_CHANGED）。

## 五、发布物料

- `.github/workflows/build.yml`：push/PR 触发 测试→构建→冒烟；打 tag 时打包 `SY-GSP-<tag>.zip` 并发布 Release。
- `README.md` / `README_en_US.md`：中英双语说明（特性、安全不变量、安装、使用、开发）。
- `plugin.json`：插件名 `SY-GSP`，`readme` 指向双语 README。

## 六、已知限制与后续建议

1. Gitee 逐文件路径在引用重读滞后时以最后一个操作返回的 commitSha 为确认值，可能与最终分支头存在短暂偏差（下一轮同步会自动收敛），如需强一致可改用 Gitee Tree API。
2. 单批请求体量上限默认 80MB（可在设置中调整 `sygsp_blob_request_limit`），超过上限的文件计入 `skippedLarge` 并在诊断面板可见。
3. 冒烟验证覆盖生命周期与错误分类链路，未覆盖真实远端交互；建议发布前用测试仓库做一次真机同步演练。
