# sy-git-sync-plugin 同步机制分析

> 分析对象：`sy-git-sync-plugin` v0.3.0 实际插件包（已上传的 `package.zip` 中的打包 JavaScript）  
> 分析目的：评估它作为 **SiYuan Android 1 + Android 2 + iPad + NAS 多端同步**基础的可行性，并确定后续 Fork/修改方向。
>
> **结论先行：**
>
> `sy-git-sync-plugin` 的同步设计明显比简单的文件同步器成熟。它不是单纯执行 `git pull && git push`，而是自己维护同步基线，并实现了 **Base / Local / Remote 三方合并、冲突检测、冲突文档、历史与回滚、删除保护等机制**。
>
> 因此，如果要做一个开源的 NAS 多端同步方案，**更适合 Fork/修改 Git Sync，而不是从 Better Sync 重新实现整个同步模型。**
>
> 但当前实现仍有几个关键问题：尤其是**跨设备没有真正的分布式锁/CAS 提交保护**，本地修改检测部分依赖时间戳，而且三方 Merge 是插件自己实现的，需要针对 SiYuan 数据进一步验证。

---

## 1. 项目定位

这个插件并不是单纯的“把 SiYuan Markdown 上传 GitHub”。

它实际上包含三层：

```text
SiYuan 数据
    ↓
SiYuan ↔ Git 数据转换/工作树
    ↓
Git 版本仓库
    ↓
同步状态 + 三方 Merge + Conflict
```

它支持的同步范围包括：

- Workspace
- `data`
- Notes
- `.sy`
- `assets`

并提供：

- 自动同步
- 本地覆盖远端
- 远端覆盖本地
- 冲突文档
- Commit 历史
- Diff
- Rollback
- 删除备份

因此它已经可以被视为一个“SiYuan 数据同步/版本管理插件”。

---

# 2. 最核心的同步模型

插件不是简单：

```text
Local ↔ Remote
```

而是维护：

```text
Base
Local
Remote
```

其中最关键的本地状态是：

```text
latest_commit_sha
latest_commit_time
```

可以理解为：

```text
latest_commit_sha
        ↓
上一次同步成功时的共同基线
        ↓
      Base
```

同步时：

```text
                  Base
                   │
          ┌────────┴────────┐
          ↓                 ↓
       Local              Remote
          │                 │
          └────────┬────────┘
                   ↓
             Three-way Merge
                   ↓
        ┌──────────┴──────────┐
        ↓                     ↓
     无冲突                   冲突
        ↓                     ↓
     合并结果             Conflict Document
```

这是该插件最值得保留的设计。

---

# 3. 并不是直接使用 `git merge`

实际代码使用 GitHub Git Data API 一类的对象操作：

```text
Blob
  ↓
Tree
  ↓
Commit
  ↓
Ref
```

也就是：

```text
文件内容
   ↓
Blob

多个 Blob
   ↓
Tree

Tree + parent
   ↓
Commit

Commit
   ↓
updateRef
```

因此：

> Git 仓库主要负责对象存储、版本历史和 Commit 图；真正的内容冲突判断/合并是在插件 JavaScript 中完成的。

这点非常重要。

---

# 4. 三方 Merge 的实际思路

源码中存在类似：

```text
Ur(base, local, remote)
```

的入口。

最终会进入三方 Diff/Merge 逻辑：

```text
Base → Local
Base → Remote
```

然后比较两个修改集合。

基本情况可以抽象为：

### 情况 A：只有 Local 修改

```text
Base = A
Local = B
Remote = A
```

结果：

```text
B
```

### 情况 B：只有 Remote 修改

```text
Base = A
Local = A
Remote = C
```

结果：

```text
C
```

### 情况 C：双方修改相同内容

```text
Base = A
Local = B
Remote = B
```

结果：

```text
B
```

不会产生无意义的冲突。

### 情况 D：双方修改不同区域

```text
Base = A
Local = B
Remote = C
```

如果修改区域不重叠：

```text
B + C
```

自动合并。

### 情况 E：双方修改同一区域且内容不同

```text
Base = A
Local = B
Remote = C
```

结果：

```text
Conflict
```

然后根据设置生成冲突文档。

---

# 5. 它不是简单的“谁时间新谁赢”

这是一个重要优点。

例如：

```text
Base
 │
 ├── Android1 修改标题
 │
 └── Android2 修改正文
```

两个修改如果互不冲突，理论上可以同时保留。

这比：

```text
mtime Local > mtime Remote
        ↓
Local 覆盖 Remote
```

可靠得多。

---

# 6. 冲突文档机制

当三方 Merge 判断为真正冲突时，插件不会简单粗暴覆盖其中一个版本。

会产生 Conflict 内容/文档。

概念上类似：

```text
<<<<<<< local
LOCAL
=======
REMOTE
>>>>>>> remote
```

对于 SiYuan 文档，还会结合 SiYuan 文档创建/转换逻辑生成冲突文档。

因此用户可以人工处理冲突。

这是非常适合知识库同步的策略。

---

# 7. 删除处理

代码会区分：

```text
added
modified
removed
renamed
```

因此删除不是简单：

```text
文件不存在
→ 立即删除远端
```

而是进入同步变化处理流程。

同时插件历史版本中还加入过删除备份：

```text
temp/GIT-SYNC-PLUGIN/backup/
```

其目的就是避免初次同步或异常判断导致数据直接丢失。

这是非常值得保留的安全机制。

---

# 8. 初次同步保护

历史版本明确修复过：

> 初次同步导致本地文件被删除。

后来加入删除文件备份机制。

这说明该项目已经实际遇到过：

```text
本地有数据
远端没有数据
```

时错误判断同步方向的问题。

因此新方案应该保留：

```text
第一次同步
     ↓
必须明确用户选择
     ↓
Local → Remote
Remote → Local
Merge
```

而不是默认执行危险覆盖。

---

# 9. `latest_commit_sha` 的意义

这是整个插件同步状态的核心之一。

例如：

```text
Remote:
A → B → C
```

某设备最后一次同步在：

```text
B
```

那么：

```text
latest_commit_sha = B
```

如果当前 Remote：

```text
C
```

本地也发生了修改：

```text
Local = D
```

则：

```text
Base   = B
Local  = D
Remote = C
```

然后执行三方合并。

因此它已经具备一个正确同步系统非常重要的概念：

> **共同祖先/同步基线。**

---

# 10. `latest_commit_time` 的作用

插件同时维护：

```text
latest_commit_time
```

用于判断本地文件是否在上一次同步之后发生修改。

基本逻辑可以理解为：

```text
file.updated > latest_commit_time
```

则认为本地存在变化。

这个设计简单，但不是完美的。

潜在问题：

- 系统时间变化
- 时钟回拨
- 文件复制保留时间
- 恢复备份
- 某些操作没有产生预期 mtime
- 多设备时钟不一致

因此后续 Fork 最好减少对 mtime 的依赖。

更可靠的方向是：

```text
Base Tree/File Hash
        ↓
当前 Local Hash
        ↓
直接判断内容是否变化
```

---

# 11. 本地 Mutex

源码存在：

```text
this.mutex
```

并使用类似：

```text
Semaphore(1)
```

的机制。

它主要解决：

```text
同一个插件实例
        ↓
多个同步操作同时执行
```

造成提交顺序混乱的问题。

例如：

```text
Sync A
 ↓
读取 Remote
 ↓
准备 Commit

Sync B
 ↓
同时读取 Remote
 ↓
准备 Commit
```

本地 Mutex 可以保证：

```text
A → B
```

按照顺序执行。

这是正确的。

---

# 12. 但是这个 Mutex 不是跨设备锁

这是当前实现最需要改进的地方之一。

例如：

```text
Android1
  mutex #1

Android2
  mutex #2

iPad
  mutex #3
```

三个 Mutex 互相不知道。

因此：

```text
Android1 ──┐
           │
Android2 ──┼──→ Git Remote
           │
iPad ──────┘
```

仍可能同时提交。

所以：

> 当前 Mutex ≠ 分布式同步锁。

---

# 13. 当前最危险的并发场景

假设：

```text
Remote HEAD = A
```

Android1：

```text
读取 A
```

Android2：

```text
读取 A
```

然后：

```text
Android1 → 创建 B
Android2 → 创建 C
```

如果两个设备随后竞争更新：

```text
refs/heads/main
```

就可能出现：

```text
A
├── B
└── C
```

但最终 HEAD 只能指向其中一个。

因此新版本应该加入：

```text
Compare-And-Swap
```

思想：

```text
updateRef(
    expectedOld = A,
    new = B
)
```

如果远端已经不是 A：

```text
拒绝提交
   ↓
重新读取 Remote
   ↓
重新进行 Base/Local/Remote Merge
```

这比单纯本地 Mutex 可靠很多。

---

# 14. Git 本身可以成为版本保护层

即使不使用 GitHub，也可以使用：

```text
Git
```

作为 NAS 中央版本仓库。

结构：

```text
NAS
└── siyuan.git
```

设备：

```text
Android1 ─┐
Android2 ─┼──→ NAS Git
iPad ─────┘
```

Git 本身提供：

- Commit
- Parent
- SHA
- History
- Diff
- Rollback

插件只需要负责：

```text
SiYuan ↔ Git
```

以及：

```text
Sync State
Conflict
Lock
```

---

# 15. 插件自身配置不会被同步

这是该插件一个明显优点。

历史 Release 明确修复：

> 插件自身配置文件不应该进入同步，因为其中包含 Token。

因此类似：

```text
GitHub Token
Remote URL
Device Config
```

必须排除。

这是 Better Sync 设计中需要重点改进的地方。

---

# 16. 二进制文件

源码会识别大量二进制扩展，例如：

```text
jpg
jpeg
png
gif
bmp
webp
mp4
pdf
doc
...
```

这些文件不能进行普通文本三方 Merge。

正确策略应该是：

```text
Base
Local
Remote
 ↓
判断是否双方修改
 ↓
冲突
 ↓
保留版本 / 生成冲突副本
```

而不是尝试文本 Diff。

---

# 17. Markdown / `.sy` 转换

插件内部存在：

```text
SiYuan ↔ Markdown
```

的数据转换逻辑。

所以它并非完全按照：

```text
data/*.sy
```

作为普通文本直接处理。

这意味着后续 Fork 必须非常谨慎：

> SiYuan 的 `.sy` 数据结构、ID、块引用、assets 等必须经过实际测试。

尤其不能只看 Git 层面“Merge 成功”就认为 SiYuan 数据一定正确。

---

# 18. GitHub 私有仓库

该插件支持通过 Token 访问 GitHub/Gitee 仓库。

因此：

```text
GitHub Private Repository
        ↓
Personal Access Token
        ↓
Git Sync
```

是可行的。

也就是说它并不要求仓库必须 Public。

但从项目当前公开资料看，它主要围绕：

```text
GitHub
Gitee
```

设计。

---

# 19. 自建 NAS Git 的价值

对于 NAS 场景，其实没必要让数据经过 GitHub。

可以在 NAS 部署：

```text
Forgejo
Gitea
```

或者使用裸 Git Repository：

```text
/srv/siyuan.git
```

最终：

```text
Android1 ─┐
Android2 ─┼──→ NAS
iPad ─────┘
```

这样：

- 不需要 SiYuan 会员
- 不依赖 GitHub
- 数据完全在自己的 NAS
- 可以私有
- 有完整历史
- 可以回滚
- 多设备共用一个中央仓库

---

# 20. 最推荐的改造方向

不是：

```text
Better Sync
   ↓
重新发明同步系统
```

而是：

```text
Fork sy-git-sync-plugin
        ↓
保留：
├── Git 版本模型
├── latest_commit_sha
├── Base/Local/Remote
├── Three-way Merge
├── Conflict Document
├── History
├── Rollback
└── Delete Backup

重新加强：
├── NAS Provider
├── 分布式 Lock
├── CAS/Expected HEAD
├── Device ID
├── 内容 Hash 检测
├── 初次同步安全流程
├── 多设备并发恢复
└── 插件配置彻底隔离
```

---

# 21. 推荐架构

```text
                         NAS
                 ┌─────────────────┐
                 │  Git Repository │
                 │                 │
                 │  Commit/Tree    │
                 │  Version/Lock   │
                 └────────┬────────┘
                          │
             ┌────────────┼────────────┐
             ↓            ↓            ↓
         Android 1    Android 2       iPad
             │            │            │
             └────────────┼────────────┘
                          ↓
                  Git Sync Plugin
                          │
              ┌───────────┴───────────┐
              │                       │
         Local SiYuan            Sync State
                                      │
                           ┌──────────┼─────────┐
                           │          │         │
                        Base SHA   Local     Remote
                                      │
                                      ↓
                               Three-way Merge
                                      │
                              ┌───────┴───────┐
                              ↓               ↓
                           Success         Conflict
                              ↓               ↓
                           Commit       Conflict Doc
```

---

# 22. 与 Better Sync 的比较

| 能力 | Better Sync | Git Sync |
|---|---|---|
| NAS | ✅ | 可改进 |
| Git 版本 | ❌/弱 | ✅ |
| Base SHA | 弱 | ✅ |
| 三方 Merge | 较弱 | ✅ |
| Conflict | 基础 | ✅ |
| History | 有限 | ✅ |
| Rollback | 有限 | ✅ |
| Delete Protection | 有限 | ✅ |
| 插件配置排除 | 需要加强 | ✅ |
| 本地 Mutex | 有限 | ✅ |
| 跨设备 Lock | ❌ | ⚠️ |
| CAS | ❌ | ⚠️需要加强 |
| 多设备中央仓库 | 不理想 | **更适合** |

---

# 23. 最终评价

### 优点

`sy-git-sync-plugin` 已经具备一个可靠同步系统最重要的几个概念：

```text
Base Version
Local Change
Remote Change
Three-way Merge
Conflict
History
Rollback
Backup
```

因此它是目前三个方向中**最值得作为 Fork 基础的项目之一**。

### 缺点

当前最需要解决：

```text
1. 跨设备分布式锁
2. updateRef 的 CAS/旧 HEAD 校验
3. mtime 依赖
4. Merge 算法对 SiYuan `.sy` 数据的实际安全性
5. NAS 自建 Git 服务支持
6. 多设备并发失败后的自动重试/重新 Merge
```

---

# 24. 建议的开发路线

### 第一阶段：不改变核心 Merge

保留：

```text
Base / Local / Remote
```

先增加：

```text
NAS Git
Device ID
Expected HEAD
```

### 第二阶段：完善并发

```text
Device A
   ↓
Lock
   ↓
Read HEAD
   ↓
Merge
   ↓
CAS Commit
   ↓
Unlock
```

如果 CAS 失败：

```text
重新读取 HEAD
       ↓
重新 Merge
       ↓
重新提交
```

### 第三阶段：完善冲突

特别测试：

```text
修改 vs 修改
修改 vs 删除
删除 vs 删除
Rename vs Modify
Asset vs Asset
Notebook 同时修改
同一 `.sy` 同时修改
```

### 第四阶段：NAS 化

支持：

```text
Forgejo
Gitea
裸 Git
```

最终让用户只需要：

```text
NAS 地址
仓库
用户名
Token/密码
```

即可连接。

---

# 25. 最终结论

**如果目标是：**

> Android 1 + Android 2 + iPad + NAS，免费、开源、不购买 SiYuan 会员，同时尽可能可靠地处理多端冲突。

那么当前最合理的路线是：

```text
                    SiYuan
                       +
              Fork Git Sync Plugin
                       ↓
          ┌────────────┴────────────┐
          │                         │
   官方同步思想              Git Sync 三方 Merge
          │                         │
          └────────────┬────────────┘
                       ↓
                  NAS Git Server
                       ↓
              Android / iPad
```

**不建议继续以 Better Sync 作为核心。**

Better Sync 的实时/P2P传输思想仍然可以借鉴，但 `sy-git-sync-plugin` 已经拥有更重要的“版本基线 + 三方 Merge”基础。

> **另外必须注意：目前公开 GitHub 仓库没有完整 TypeScript 源码，实际分析主要基于上传的 v0.3.0 打包 JavaScript。因此如果继续开发，第一步应该把打包 JS 进一步拆成模块、还原关键函数，并针对多设备并发场景做测试，而不是直接大规模重写。**
