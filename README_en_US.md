# SGSP

[中文](./README.md)

SGSP is a SiYuan Git synchronization plugin maintained by `MbAIGC` for synchronizing local files with GitHub and Gitee repositories.

> This project is forked from the v0.3.0 release package of [xstarling/sy-git-sync-plugin](https://github.com/xstarling/sy-git-sync-plugin).
> It is named **SGSP** to avoid sharing the original plugin's name. Many thanks and respect to the original author, [xstarling](https://github.com/xstarling), for the design and implementation.
> This version fixes sync-status notification issues and adds a complete conflict-handling loop
> (see "Sync status & conflict handling" below).
> Refactor details: [docs/REFACTOR-NOTES.md](./docs/REFACTOR-NOTES.md).

## Changelog

- Full changelog: [CHANGELOG.md](./CHANGELOG.md) (self-contained in the repo, no external links required).
- Key changes in 0.3.1:
  1. On conflict, auto sync is paused, a persistent dialog lets you choose how to proceed, and auto sync resumes automatically after the conflict is resolved;
  2. The top-bar icon shows a red badge while a conflict is pending;
  3. Both READMEs were rewritten (terminology/typo fixes, clearer feature descriptions).

## Feature list

+ **🚧 Large-file synchronization (under development)**
  - 🚀 Combines the git repository with Baidu Cloud Drive / Aliyun Drive for large-file uploads
+ **🚀 Function menu**
  - 🚀 Start synchronization: run synchronization between local and remote
  - 🚀 Refresh / update data
    - 👉 Refresh work tree: fixes missing note IDs (【ID not found!】) after synchronization
    - 👉 Update resource path: restores local resources when they fail to display because of a custom `assets/` resource path
  - 🚀 Sync scope
    - 👉 Workspace: all important workspace data is synchronized to the git repository
    - 👉 Data directory (`data`): files under the `data` directory are synchronized
    - 👉 Note files: SiYuan note files under `data` and `assets` image resources
  - 🚀 Sync strategy
    - 👉 Auto sync: the system compares and merges local and remote data automatically
    - 👉 Choose direction: a dialog lets you pick [Cloud overwrites local] or [Local overwrites cloud], optionally forced
    - 👉 Cloud overwrites local: in non-forced mode, conflicts generate a conflict document (if "Generate conflict document on conflict" is enabled), otherwise a prompt is shown
    - 👉 Local overwrites cloud: in non-forced mode, conflicts generate a conflict document (if enabled), otherwise a prompt is shown
  - 🚀 Note format
    - 👉 SiYuan notes: files synchronized to the remote repository use the SiYuan note format (note files only)
    - 👉 Markdown: files synchronized to the remote repository use Markdown format (note files only)
  - 🚀 Sync mode
    - 👉 Auto sync: synchronize periodically at the interval configured in settings
    - 👉 Manual sync: synchronize once at startup only; not triggered at shutdown
    - 👉 Fully manual sync: no sync at startup or shutdown; click [Start synchronization] to sync
  - 🚀 Sync history
    - 👉 Local commits: all remote commits up to the local device's last commit
    - 👉 Remote commits: all remote commits up to now
    - 👉 File search: filter commits by notebook, file ID/path, and time range
    - 👉 Commit node: hover a commit in the sidebar history to see its summary
    - 👉 Commit files: click a commit node to list the files in that commit
    - 👉 File diff: opens a diff panel comparing the commit file with the local file
    - 👉 Rollback file: the 【⤴︎】 button downloads the committed file and overwrites the local copy
    - 👉 Download file: the 【↓】 button downloads the committed file and reports where it was saved
+ **🚀 Settings**
  - 🚀 User info: [repository platform] [repository URL] [repository name] [branch name] [platform username] [email]; the plugin works only after these are filled correctly
  - 🚀 Ignore files: paths or file names to skip during synchronization
  - 🚀 Resource file path (must end with【assets/】): replaces the `assets/` prefix in synchronized resource links with a custom prefix
  - 🚀 Token / SSH: personal token for accessing GitHub / Gitee repositories
  - 🚀 Generate conflict document on sync conflict: when enabled, a conflict document is created locally on conflict; when disabled, only a prompt is shown
  - 🚀 Sync scope: see 【Function menu】→【Sync scope】
  - 🚀 Sync mode: see 【Function menu】→【Sync mode】
  - 🚀 Sync interval: interval of auto sync
  - 🚀 Last commit SHA: the hash of the last local commit (read-only)
  - 🚀 Last commit time: when the local device last committed (read-only)

## Sync status & conflict handling (new in 0.3.1)

The plugin now has a complete **conflict-handling loop** and no longer spams transient
error toasts while auto sync keeps failing.

```text
Conflict detected
   ↓
🔴 Conflict state
   ↓
Auto sync paused
   ↓
User notified
   ↓
User chooses
   ├── Keep local version
   ├── Keep remote version
   ├── Open conflict document
   └── Later
   ↓
Conflict resolved
   ↓
🟢 Auto sync resumed
```

### What you see on conflict

1. The top-bar plugin icon turns 🔴 red and blinks (tooltip: "Conflict unresolved, auto sync paused");
2. A persistent dialog "⚠️ Sync conflict detected" shows the conflicted file path;
3. **Auto sync is paused** — no more repeated sync attempts or repeated error toasts.

### Your options

| Action | Effect |
|---|---|
| Keep local version | Forced "local overwrites cloud" sync + commit; auto sync resumes afterwards |
| Keep remote version | Forced "cloud overwrites local" sync + commit; auto sync resumes afterwards |
| Open conflict document | Best-effort search & open of the generated `_conflict_` document (stays paused) |
| Later | Close the dialog, stay paused (red badge remains); you can handle it any time later |

> If "Generate conflict document on sync conflict" is enabled, conflict documents are
> created next to the original (file name contains the `_conflict_` prefix) and can be
> deleted after resolution.

### Other states

- Syncing: the top-bar icon rotates;
- Sync failure (network / token / repository not initialized): keeps the original error prompts;
- The paused state is **persisted**, so it survives a SiYuan restart until you resolve the conflict.

Design details: [docs/CONFLICT-WORKFLOW.md](./docs/CONFLICT-WORKFLOW.md).

## Usage

- Install (direct): copy the plugin package files at the repo root
  (`index.js`, `index.css`, `plugin.json`, `i18n/`, `icon.png`, `preview.png`,
  plus `README.md`) into `data/plugins/SGSP/` in the SiYuan workspace,
  then restart SiYuan.
- Install (recommended): download `SGSP-<version>.zip` from the
  **GitHub Actions artifacts** or a **v* tag Release**, unzip it into
  `data/plugins/SGSP/`.
- First run: fill in platform / repository / username / email / token in settings, then click [Start synchronization].
- It is recommended to verify the sync direction with a test repository first.

> Official detailed guide (external): [GIT sync plugin instructions](https://kdocs.cn/l/caGt3BWn9r5G?linkname=ArymAS7rZm)

## Project layout (developers)

```
├── index.js                build output: official v0.3.0 bundle + conflict-flow injection (committed)
├── index.css / plugin.json / i18n/ / icon.png / preview.png   plugin package files (repo root IS the package)
├── vendor/index.js         official v0.3.0 bundle (patch input; read-only reference)
├── vendor/index.beautified.js   beautified official bundle (for analysis)
├── src/sync-flow-runtime.js     conflict loop / state machine / notifications (single source of truth)
├── patch/apply-patch.mjs        patch injection & build script (shared by CI and local)
├── tests/                      unit tests (node --test)
├── smoke/                      end-to-end smoke verification (siyuan stub)
├── docs/                       design docs (conflict workflow / refactor notes)
├── .github/workflows/build.yml    GitHub Actions: test → build → package → release
└── README.md / README_en_US.md / CHANGELOG.md
```

> Rebuild the plugin package: `node patch/apply-patch.mjs` (idempotent; default version
> `0.3.1`, override with the `GIT_SYNC_VERSION` env var; CI runs it automatically).

## Precautions

> [GIT sync plug-in - disclaimer](https://kdocs.cn/l/caGt3BWn9r5G?linkname=hMZxlMSs8z) <br>
> The software (hereinafter referred to as "the Software") is developed by an individual and aims to provide users with note-data synchronization. By using the Software, you signify that you have read, understood and agreed to the entire contents of this disclaimer.

+ 💻 1. Data security
  - 🚀 As this plug-in is developed by an individual, system testing may be limited. **Users are advised to enable SiYuan snapshots or back up data regularly** in case of data loss.
  - 🚀 The use of this plug-in may involve unforeseen risks, such as data loss, corruption, or synchronization errors. Users should assess the risks of use on their own, to the extent permitted by applicable law.
+ 💻 2. Privacy and permissions
  - 🚀 The software does not actively collect, store, or share users' personal information. All data processing is carried out locally on user devices or in Git repositories authorized by the user.
  - 🚀 Users should properly manage their Git accounts, API tokens, and related credentials, and are responsible for their data security and access.
+ 💻 3. Risk of use
  - 🚀 Users use the Software at their own risk. The developer shall not be liable for any direct or indirect losses arising from the use of the Software, including but not limited to data loss, account blocking, device damage, or third-party liability.
+ 💻 4. Others
  - 🚀 For other considerations, see the disclaimer in the plugin settings or the external document above.

## Project management

1. Changelog (in-repo): [CHANGELOG.md](./CHANGELOG.md)
2. Conflict workflow design: [docs/CONFLICT-WORKFLOW.md](./docs/CONFLICT-WORKFLOW.md)
3. Refactor notes: [docs/REFACTOR-NOTES.md](./docs/REFACTOR-NOTES.md)
4. Official documents (external): [features](https://kdocs.cn/l/caGt3BWn9r5G?linkname=k7VAb4Wx5b), [usage](https://kdocs.cn/l/caGt3BWn9r5G?linkname=ArymAS7rZm), [disclaimer](https://kdocs.cn/l/caGt3BWn9r5G?linkname=hMZxlMSs8z)
5. Feedback: [👥 SGSP feedback group (QQ: 1015180920)](https://kdocs.cn/l/caGt3BWn9r5G?linkname=Ij7mC9wG6q)
6. FAQ: [FAQ document](https://kdocs.cn/l/cf8qSfWUdi1O)