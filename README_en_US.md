# SY-GSP

[中文](./README.md)

SY-GSP is a SiYuan note plugin that syncs notes with GitHub / Gitee repositories. It is a complete rewrite based on the "Sync Engine 2.0" design: three-way merge, a conflict center, and confirmed-base tracking — it never fakes success.

> The predecessor of this plugin was SGSP (forked from [xstarling/sy-git-sync-plugin](https://github.com/xstarling/sy-git-sync-plugin) v0.3.0). SY-GSP is a brand-new implementation; the legacy source is archived under `SGSP-V1/` in this repository for reference only.

## Highlights

- **Three-way merge**: local and remote changes are merged against the confirmed base (BASE). Non-overlapping edits merge automatically; overlapping conflicts go to the conflict center and are never silently overwritten.
- **Confirmed-base tracking**: the base is updated only after a push is confirmed on the remote. Legacy commit SHAs are treated as diagnostic hints only, never as a base.
- **Conflict center**: on conflict, auto sync pauses and the conflict snapshot is persisted. You choose per file between "keep local" and "keep remote"; sync resumes automatically afterwards.
- **Classified errors with bounded retry**: network / timeout / remote-moved / push-rejected errors are classified; only retryable categories are retried a limited number of times, and every retry re-plans first.
- **First-sync wizard**: without a base, the plugin runs read-only diagnosis and shows a plan preview; the first write happens only after you confirm the direction.
- **Dual platform**: GitHub (atomic tree commit + CAS ref update) and Gitee (per-file Contents API), detected from the repository address.
- **Sync history**: the last 100 sync records are persisted locally with state, phase and error details.
- **Full settings parity**: sync range / strategy / note format / sync mode, ignore rules, asset prefix, plus new options for auto retry, success notifications and per-request size limits.
- **Migration**: legacy SGSP settings are imported automatically on first run; the legacy base commit is shown as a hint only.

## Safety invariants

1. Never write to the remote without confirmed remote state.
2. Never update the local base before a remote operation is confirmed.
3. Never auto-overwrite either side on unmergeable conflicts.
4. Report push failures honestly (e.g. `PUSH_UNCONFIRMED`); no fake success.
5. Deletes pass multiple guards (base exists, manifest entry exists, in sync scope); doubtful deletes are skipped and reported.

## Install

1. Download a release package (GitHub Releases) or build from source (see "Development");
2. In SiYuan: Settings → External plugins → import the `SY-GSP` folder (containing `index.js`, `index.css`, `plugin.json`, `i18n/`);
3. Enable the plugin and fill in the repository address, branch and token (with repository read/write permission).

## Usage

- Top bar icon: click to sync manually; a red badge means pending conflicts — click it to open the conflict center.
- Settings panel: platform / address / branch / token, sync range, strategy, mode, ignore rules, asset prefix, etc.
- Command palette / context menu: start sync, open settings, sync history, diagnosis panel, conflict center.

## Development

```bash
npm install          # install dependencies (node-diff3 + esbuild)
npm test             # unit tests (node:test)
npm run build        # bundle to index.js (CJS, external siyuan)
npm run smoke        # smoke test: load the built plugin with stubs
npm run verify       # test + build + smoke
```

## License

[MIT](./LICENSE)
