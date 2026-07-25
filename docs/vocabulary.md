# Vocabulary Migration — Decisions & Execution Plan

**DO NOT ACT ON THIS BEFORE USER REVIEW AND EXPLICIT INSTRUCTIONS.**

**Status: DRAFT v1 — awaiting review of the ⚖ decisions below.**
Companion to [ontology.md](ontology.md) (the constitution). This file is the
migration order: every old term, its replacement per layer, the contract
(persisted/wire) items with their strategy, and the execution waves.
Full grep inventories were generated 2026-07-02 (session scratchpad,
`inventory-code.md` / `inventory-docs.md`); executors should re-grep — counts
below are for sizing only.

## Migration stance

**Clean break.** Per `activity-review-rethink.md`: zero users, zero
backward-compat obligation. No permanent aliases. Two concessions only:

1. **App manifest filename stays `package.json`** (with the `mim` block).
   npm-ecosystem convention; VS Code extensions set the precedent. The *word*
   "package" is banned everywhere else.
2. **Boot-time auto-migration of `.mim/` paths** (rename dir/file if the old
   name exists) so our own workspaces survive. One release, then the shim dies.

Optional Team repositories migrate their owned apps independently and verify
them with `npm run test:team:compat`.

## Decision table

| # | Old | New | Layers affected | Size (hits) | Contract items |
|---|---|---|---|---|---|
| 1 | **package / packages / pkg** | **app / apps** | tools `package.*`→`app.*` (create/edit/delete/readme/validate/reload/list/install/update/uninstall/capabilities.list, `package.jobs.*`→`app.jobs.*`, `package.data.*`→`app.data.*`, `package.secrets.*`→`app.secrets.*`); IPC `kernel:packages`→`kernel:apps`, `kernel:package-launch-url`; ws event `package:job:event`→`app:job:event`, `packages:changed`→`apps:changed` (already exists — merge); HTTP `/packages/:id`→`/apps/:id`; SDK `get package()`→`get app()`; types `LoadedPackage`→`LoadedApp` etc.; dirs `src/main/packages/`→`apps/`, `src/renderer/components/packages/`→`apps/`; kinds `package-run`→`app-run`, `package-view`→`app-view`; RunKind `package-job`→`app-run`; skill id syntax `package:<id>/<skill>`→`app:<id>/<skill>`; docs `package-system-api.md`→`app-system-api.md`, `package-runtime.md`→`app-runtime.md` | ~2250 (+1392 test) | `.mim/packages/enabled.json`→`.mim/apps/enabled.json` (boot-migrate); workspace `packages/` folder → ⚖ D3; manifest filename stays (concession 1); `mim.yaml` key already `apps:` ✓ |
| 2 | **session** (chat cluster) | **chat** | types `Session`→`Chat`, `SessionMessage`→`ChatMessage`; files `sessions.ts`→`chats.ts`, `sessionManifest.ts`, stores, `SessionRow.vue`, `SessionContextMenu.vue`; MCP `search_sessions`→`search_chats`; search scope enum `"sessions"`→`"chats"`; IPC `gate:cancel-session`→`gate:cancel-chat`; kinds `chat`/`chat-draft` ✓ stay | ~3000 of 3547 (rest is agent/browser clusters — see Do-Not-Touch) | `.mim/sessions/`→`.mim/chats/` (boot-migrate); persisted JSON field names inside chat records stay schema-versioned, migrate on read |
| 3 | **agent session** | **agent run** | `agentSessions.ts`→`agentRuns.ts`, `AgentSessionRecord`→`AgentRunRecord`, `AgentSessionView.vue`→`AgentRunView.vue`; kind `agent-session`→`agent-run`; tool `agent.sessions.*`→`agent.runs.*`; docs `agent-sessions.md`→`agent-runs.md`; UI "Archived agent session"→"agent run" | ~479 | agent-run JSON records on disk (boot-migrate path if named); `cliSessionId` KEEPS its name — it is the CLI tool's own session id (external vocabulary) |
| 4 | **archive / unarchive / archived** | **Done / Reopen / History** | verbs: context menus "Archive"→"Done", "Archive all"→"Mark all done", "Unarchive"→"Reopen", `sessionStore.restore()`→`reopen()`; `ArchiveBrowser.vue`→`HistoryBrowser.vue`, dir `components/archive/`→`components/history/`; kinds `work:archive`→`work:history`, `'archive'`→`'history'`, routes `open-archive`→`open-history`; card copy "Archived chat"→"Done chat" ⚖ D5; tools `agent.sessions.archive`→`agent.runs.done`, `package.jobs.archive`→`app.jobs.done` | ~478 | persisted `archived: boolean` on chat records → `done: boolean`, migrate on read ⚖ D6 |
| 5 | **Monitor / Trust / activity-trust** | **Review** | sidebar key `trust`→`review`, label "Monitor"→"Review"; kind `activity-trust`→`review`; `ActivityTrustView.vue`→`ReviewView.vue`, dir `components/activity/`→`components/review/`; route `open-monitor`→`open-review`; palette + labels.ts; in-surface tabs: "Monitor"→"Overview" ⚖ D8, "Audit" stays | ~85 real (grep noise: `github-monitor` fixture) | none |
| 6 | **resource / resources** | **collection / collections** | tools `resources.*`→`collections.*`; `resourceModel.ts`→`collectionModel.ts`; `ResourceCollection`→`Collection`; stores, `ResourcesSettingsPanel.vue`→`CollectionsSettingsPanel.vue`; UI "Shared resources"→"Collections" ⚖ D9; docs `resources.md`→`collections.md`; DEFAULT_AGENTS_MD stale `resources` key → `collections` (schema already correct ✓) | ~600 domain | `.mim/resources/` mount root → `.mim/collections/` and machine `resources.json`→`collections.json` (boot-migrate + re-link symlinks) |
| 7 | **history** (file recovery) | **snapshot / Snapshots** | `src/main/history/`→`snapshots/`, `tools/history.ts`→`snapshots.ts`; MCP + tools `history_list`/`history_restore`→`snapshot_list`/`snapshot_restore`; `HistoryRail.vue`→`SnapshotsRail.vue`, rail header "History"→"Snapshots"; Files menu "Version history..."→"Snapshots..."; UI verb "Restore"→"Go back" ⚖; docs `history.md`→`snapshots.md`; systemPrompt tool prose | ~374 raw (needs cluster filter) | `.mim/history/`→`.mim/snapshots/` (boot-migrate) |
| 8 | **job / jobs** | internal-only (inside app runtime) | public kinds/records: `PackageRunRecord`→`AppRunRecord`, `packageRunsDir`→`appRunsDir`; RunKind merge (see #1); events `job.started/...` and SDK `mim.jobs.*` STAY (app-author API for background work — ontology second-tier "Job") | ~586 | SDK `mim.jobs.*` kept deliberately |
| 9 | **status words** | one RunStatus set | `completed`→`done`, `failed`→`error`, `cancelled`/`interrupted`→`stopped` across the five enums; collapse to shared types (see Wave 5 bonus) | ~247 | persisted status literals in run/chat records → migrate on read |
| 10 | **project / folder** (= workspace) | **workspace** | `AddProjectDialog.vue`→`WorkspaceDialog.vue`; titles "New Folder"/"Clone Repository"→"New Workspace"/"Clone Workspace"; switcher "Open Folder..."→"Open Workspace...", event `add-project`→`add-workspace`; labels.ts "Project" fallbacks ⚖ D10 | ~55 real | none |
| 11 | **Control** (effort picker) | **Effort** ⚖ D7 | `ControlPicker.vue`→`EffortPicker.vue`, label/aria "Control"→"Effort"; `modelControls.js` naming | ~78 targeted | persisted `controlId` in chat records → `effortId`, migrate on read |
| 12 | **workflow** (RunKind) | deleted | `stores/runs.ts` now uses `routine` for routine sessions and has no `workflow` member | done | none |
| 13 | **Activity** (sidebar section) | **Runs** ⚖ D2 | ShellSidebar section header, "No activity"→"No runs", "New activity" aria, "Toggle Activity" | small | none |
| 14 | **"Review"** (diff/status overloads) | free the word for the surface | InlineApproval "Review change"→"View change"; DiffReviewBar visible labels "Review all"→"All changes"; status chip "Review"→"Changes" ⚖ D8; lowercase verb "review" in prose stays legal | small | none |

## Allowed survivals (explicitly NOT banned)

- `package.json` as the app-manifest filename (concession 1).
- **trust** as a *verb/flag* for app & registry acknowledgement (`app.trust`,
  `registry.trust`, `trusted: boolean`). Banned only as a surface name.
- **job** inside the app runtime and SDK (`mim.jobs.*`) — second-tier concept.
- `cliSessionId` — external CLI tools' own vocabulary.
- lowercase "review/restore/mount/monitor" as plain-English verbs in prose,
  never as feature names.

## Do-not-touch list (grep traps)

- `browserSession*` (~284 hits) — web-automation sessions, separate concept.
- `services/workbench/history.ts` (`PaneHistory`, back/forward) — pane
  navigation, not Snapshots, not History-the-surface.
- Vue Test Utils `mount()` helpers (`mountSidebar`, …, ~283 hits).
- `github-monitor` test fixture app id (165+ hits in `install.test.ts`).
- `vi.restoreAllMocks()` and app/window `restore*` lifecycle (~200 hits).
- `projectFiles` / `project-file` chip type + "project library" bibliography
  source — citation domain, out of scope (candidate for a later pass).
- npm `package.json` handling that is genuinely npm, not the Mim manifest.

## ⚖ Open decisions (review before execution)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Full-depth chat rename (types + storage dir), or UI/docs only? | **Full depth.** Zero users; doing it later costs more. |
| D2 | Sidebar section "Activity" → "Runs"? | **Yes.** Alternative (keep "Activity" as a plain label) re-opens the noun. |
| D3 | Workspace `packages/` folder → `apps/`? Committed user contract + Team app layout. | **Yes, hard rename;** loader dual-reads `apps/` then `packages/` for one release; scaffold + docs say `apps/`. |
| D4 | Keep `package.json` as manifest filename? | **Yes** (npm tooling, VS Code precedent). |
| D5 | Lifecycle verb: "Done" (current footer button) vs "Archive"? | **Done / Reopen.** Warmer, matches research workflow; "Archive" dies. |
| D6 | Rename persisted `archived` field → `done`? | **Yes,** migrate-on-read; trivial while user count ≈ 0. |
| D7 | "Control" picker → "Effort"? Confirm the picker only controls effort. | **Effort** if so; if it multiplexes, name it for what it does. |
| D8 | Review-surface tab labels: "Monitor"→"Overview", status chip "Review"→"Changes"? | **Yes** to both; keeps capital-R Review unambiguous. |
| D9 | "Collection" vs "Shared folder" as the user-facing word? | **Collection** — shorter, matches `mim.yaml` `collections:` already shipped. |
| D10 | Workspace-wording pass on dialogs/menus (D10 = #10 above)? | **Yes.** |

## Execution waves (each lands with a green suite)

- **Wave 0 — Freeze.** Land ontology.md + this file. Add banned-words CI check
  in *warn* mode (see below). No new code may introduce old terms.
- **Wave 1 — Surfaces & verbs** (small, visible, high impact): #5 Review,
  #4 Done/Reopen/History, #10 workspace wording, #11 Effort, #13 Runs,
  #14 review-word cleanup, #12 delete dead RunKind.
- **Wave 2 — App rename** (#1, #8): tools, SDK, IPC, events, dirs, types,
  templates + DEFAULT_AGENTS_MD + TOOL_CATALOG, docs renames, boot migration,
  coordinated Team updates, compatibility suite green.
- **Wave 3 — Chat & agent-run rename** (#2, #3): the largest; includes
  `.mim/sessions/`→`.mim/chats/` migration and MCP/search renames.
- **Wave 4 — Collections & Snapshots** (#6, #7): tool namespaces, boot
  migrations, symlink re-link, doc renames.
- **Wave 5 — Status unification** (#9) + bonus structural fix: extract the 8
  duplicated main↔renderer interfaces into a shared types module so the
  vocabulary can never fork between processes again.
- **Wave 6 — Docs sweep & enforcement.** Full docs/_MAP pass, cross-reference
  fixes, flip the CI check to *error* mode.

## Banned words (CI check, Wave 0 warn → Wave 6 error)

Scope: UI strings, tool/IPC/event names, docs prose, identifiers in `src/`,
`sdk/`, `docs/`. Per-word allowlists per the survivals above.

`package` (except manifest filename + npm contexts) · `archive`/`unarchive` ·
`monitor` (except fixture) · `trust` as surface · `resource(s)` ·
`session` user-facing (except `browserSession`, `cliSessionId`) ·
`activity` as concept · `workflow` RunKind · `project`/`folder` for workspace ·
`completed`/`failed`/`cancelled`/`interrupted` as run statuses ·
`restore` for runs · `Control` as picker label.
