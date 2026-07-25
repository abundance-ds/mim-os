# _MAP.md — Codebase Navigation Map

Start here when changing the codebase. This is a navigation index, not a design doc.

## Read This First

- This is an Electron app. Main process is Node.js. Renderer is Vue 3 + Pinia.
- [gotchas.md](gotchas.md) — non-obvious constraints. Add to it when a fix depends on a subtle rule.
- [security.md](security.md) — permission/trust model. Read before changing `gate.ts` or approval flow.
- [design-system.md](design-system.md) — visual language, tokens, interaction rules. Read before UI work.

## Quick Start

```bash
npm install && npm run build && npm run test
npm run dev                        # launch app
MIM_TEAM_PATH=../mim-team npm run test:team:compat
```

## Architecture Overview

```
Electron App
  Main Process (Node.js)
    Boot (index.ts) → Tool Registry → Trace Log → Search DB → Server
    ├─ agents/        CLI agent catalog, session lifecycle, pty status tracker
    ├─ ai/            model registry, runtime, agent context, system prompt
    ├─ packages/      loader, manifests, enablement, runtime, jobs, data, HTTP, secrets
    ├─ comments/      inline comment models (markdown tags, code @mim markers) + path dispatch
    ├─ search/        SQLite FTS, file content search, text matching
    ├─ security/      permission gate and path classifier
    ├─ subagents/     durable delegated-thread scheduler and persisted types
    ├─ team/          one writable Git-backed Team connection and contract
    ├─ server/        Express + WebSocket for apps/AI/MCP
    ├─ workspace/     boot, mim.yaml contract, file watcher
    ├─ tools/         registry + all tool modules
    ├─ integrations/  Slack, Google, keychain secrets, HTTP boundary
    ├─ trace/         unified trace stream: spans, audit, bounded content objects
    ├─ sessions.ts    chat session CRUD, JSON file storage
    ├─ pty.ts         terminal spawning (node-pty, shared with agent sessions)
    ├─ skills.ts      filesystem SKILL.md loader
    └─ headless.ts    non-Electron CLI registry

  Preload (preload/index.ts)
    window.kernel.call() ↔ ipcRenderer.invoke()

  Renderer (Vue 3 + Pinia)
    App.vue + services/appShell/    Navigator / Work / Artifact shell
    ├─ ChatView                     AI SDK Chat + DefaultChatTransport
    ├─ EditorPanel                  unified document tabs (CodeMirror, PDF, table, file cards)
    ├─ TerminalPanel                xterm.js + pty IPC
    ├─ Workbench store              pane history, layout invariants, command path
    ├─ Runs store                   chat/app/agent session aggregation
    └─ Workbench components         NavigatorPane, WorkPane, ArtifactPane, hosts

  App Iframes
    runtime.call() → SDK WebSocket → Server → Tool Registry
```

## Systems

Each entry is a one-liner with the source cluster and relevant docs. Read the linked files for implementation detail.

### Main Process — Core

- **Electron shell.** App lifecycle, window creation, IPC, quit guard, and macOS close-to-hide/Dock restore behavior. `src/main/index.ts`, `closeGuard.ts`, `platform.ts`, `menu.ts`, `windows/windowLifecycle.ts`.
- **Tool registry.** Universal dispatch with actor context and trace logging. `src/main/tools/registry.ts`.
- **Permission gate.** Approval policy for AI/app tool calls, keyed on effect (read/mutate/external). `src/main/security/gate.ts`, `gate-paths.ts`. Docs: [security.md](security.md).
- **File tools.** read/write/edit/create/delete/list/rename/copy/trash, workspace-scoped, stale-write protection via content hashes. `src/main/tools/fs.ts`, `workspaceFileWatcher.ts`.
- **Local file history.** Optional per-file recovery under `.mim/history/`, independent of git, with resumable authored-text baselines, automatic exact/daily/weekly retention, and a soft byte budget. The normal Project control is on/off; technical storage controls live under Advanced. `src/main/history/`, `tools/history.ts`. UI: `HistoryRail.vue`, `StorageSettingsPanel.vue`. Docs: [history.md](history.md).
- **Sessions.** Chat session CRUD, atomic JSON in `.mim/sessions/`, manifest cache, and durable child-thread metadata. `src/main/sessions.ts`, `sessionManifest.ts`.
- **Subagents.** Durable AI-created child sessions with asynchronous queueing, event-driven waits, scheduler lease release, safe-boundary steering, contextual follow-ups, interruption/stop, result paging, inherited authority, MCP exposure, and Navigator runs. `src/main/subagents/`, `tools/subagents.ts`, `ai/aiRuntime.ts`, `security/gate.ts`, `src/renderer/stores/runs.ts`. Docs: [subagents.md](subagents.md).
- **Routines.** Team and Project definitions resolved into one catalog with Project overrides; revision-aware create/edit/duplicate/Trash lifecycle; machine-local four-state activation, visible machine ownership, and run state under `.mim/routines/`; manual chat-turn runs; desktop and always-on schedule/file/webhook/Slack automation; isolated scheduled-run retry; source-file live refresh; authority review; routine session metadata; and the dense Routines work surface. `src/main/routines/`, `tools/routines.ts`, `server/server.ts`, `headless.ts`, `sessions.ts`, `src/renderer/components/routines/`, `src/renderer/stores/routines.ts`. Docs: [routines.md](routines.md), [design-system.md](design-system.md#617-routines-work-surface).
- **Workspace.** Boot (restore last or create default), `mim.yaml` contract (schema, init detection, scaffold), scoped open-file watcher. `src/main/workspace/`. Docs: [git.md](git.md) for sync.
- **Git tools.** Status/diff/log/commit/pull/push plus managed Project sync with Git/LFS preflight, open/save/quit lifecycle automation, offline retry, and conflict-copy preservation. `src/main/git.ts`, `src/main/sync/`, `tools/git.ts`, `tools/sync.ts`.
- **Team.** One optional Personal connection, deterministic `~/.mim/team/` checkout, required release index with full content-integrity verification, background update discovery without automatic installation, one accepted-update path, exact permission re-review, writable local publishing, conflict-copy preservation, safe Project mount at `.mim/team`, and live refresh after connection or update. `src/main/team/teamSource.ts`, `teamRelease.ts`, `teamReleaseContents.ts`, `teamFiles.ts`, `liveTeamRefresh.ts`, `tools/team.ts`. Docs: [team.md](team.md); Git behavior: [git.md](git.md).
- **Personal config.** `~/.mim/config.yaml` (identity, appearance/editor/layout preferences, integration account defaults, model defaults, skill activation, and one credential-free Team repository). Never holds keys or tokens. `src/main/userConfig.ts`.
- **Settings tools.** Route Personal preferences to `~/.mim/config.yaml` and current-Project runtime/tool state to `.mim/settings.json`; agent tool availability policy remains Project-local for Settings > Tools. `src/main/tools/settings.ts`, `src/main/tools/toolPolicy.ts`.
- **Bridge tools.** Cross-surface messaging: `editor.open`, `terminal.run`, `chat.send`. `src/main/tools/bridge.ts`.
- **Editor state tool.** `editor.state` (MCP: `editor_state`): open tabs + active document snapshot, pushed by the renderer and cached in main. `src/main/tools/editorState.ts`.
- **Headless CLI.** `mim` command over the shared tool registry; no Electron. `mim tui <app>` hosts an enabled app-owned terminal interface, with `mim k` as the Knowledge shortcut; `mim always-on` adds background Team/Project sync, schedule/file/webhook/Slack automation, heartbeat status, and graceful shutdown for an operator-managed machine. `src/main/cli.ts`, `headless.ts`, `tui/packageTui.ts`. Docs: [cli.md](cli.md).
- **MCP bridge.** Local stdio bridge from external CLI agents to the running desktop, with atomic process-owned discovery and ownership-safe restart cleanup. `src/main/mcp/`, `src/main/server/server.ts`. Docs: [mcp.md](mcp.md).
- **Preload bridge.** `window.kernel` IPC gateway. `src/preload/index.ts`.

### Main Process — AI

- **Model registry.** Model catalog with provider-published context windows, standard/cache rates, and long-context billing tiers; key resolution (`~/.mim/keys.env` → env); model-default cascade. `src/main/ai/ai.ts`, `resources/ai-models.json`.
- **AI runtime.** Vercel AI SDK provider calls, ToolLoopAgent profiles, ghost generation, tool wrapping, provider-aware usage/cost estimation, context tracking, model-context compaction views, effective compacted context counters, and threshold/overflow-triggered historical summaries. Renderer shows event-anchored, trigger-aware compaction dividers, compacted-context donut copy, and transient pre-stream context status from session metadata and local turn estimates. `src/main/ai/aiRuntime.ts`, `src/main/ai/compaction.ts`, `src/main/ai/messageCompaction.ts`, `src/renderer/components/chat/compactionDivider.ts`, `src/renderer/components/chat/contextCompactionStatus.ts`.
- **System prompt.** Template-based from `AGENTS.md` with `{{TOOL_SET}}`, `{{SKILL_CATALOG}}`, `{{WORKSPACE_TREE}}`, `{{PROJECT_LOG}}` etc. `src/main/ai/systemPrompt.ts`, `workspaceTree.ts`.
- **Agent mounts.** Resolve app `agents` exports into `AgentProfile`s, build constrained instructions context, template-var resolution, tool-allowlist intersection, per-turn skill pre-activation. `src/main/ai/agentMounts.ts`.
- **Agent context.** Deterministic `.mim/agent-context.md` digest with workspace/app/git health. `src/main/ai/agentContext.ts`, `packages/packageContributions.ts`.

### Main Process — Execution & Terminal

- **Toolchain detection.** Catalog of R/Rscript/Quarto/pandoc/python3 with login-shell binary resolution, version capture, and promise cache. `src/main/toolchain/toolchain.ts`. Docs: [code-execution.md](code-execution.md).
- **Code execution.** `shell.run` (AI key: `bash`) unified shell tool and `code.run` allowlisted interpreter tool: spawn, output tail caps, product scan, run records, plot-capture harness. `src/main/tools/code.ts`, `resources/r/mim-run.R`. Docs: [code-execution.md](code-execution.md).
- **Terminal (PTY).** node-pty spawning, shell integration, keybinding profiles, program tabs (toolchain-validated). `src/main/pty.ts`, `ptyCommand.ts`, `ptyShellIntegration.ts`.
- **Agent sessions.** CLI coding agents (Claude Code, Codex, Gemini CLI, Pi 0.76+) as first-class runs with compatibility detection, deterministic resume, placeholder-safe prompt auto-titles, idle-before-first-prompt status tracking, explicit blocking-input signals (including Codex Action Required titles), and stop/archive lifecycle. Pi sessions automatically load an unpacked first-party extension that exposes the curated Mim tool catalog and lifecycle title signals over the per-session authenticated desktop socket. `src/main/agents/`, `resources/pi/`. Docs: [agent-sessions.md](agent-sessions.md).

### Main Process — Web & Content

- **Web tools.** `web.search` (Exa), `web.read` (simple stateless/PDF reader), `web.live.open`, and `web.live.act` (Markanywhere-port live browser with bounded observations, compact action refs, and desktop-local loopback preview support). MCP exposes these as `web_search`, `web_read`, `browser_open`, and `browser_act`. `src/main/web/`, `tools/web.ts`. Docs: [web-reading.md](web-reading.md).
- **HTML-to-Markdown.** Pure parser shared by web readers and DOCX extraction. `src/main/html/markdown.ts`. Docs: [html-markdown.md](html-markdown.md).
- **Document import.** DOCX/XLSX/BibTeX/PDF → Markdown. `src/main/documents/importMarkdown.ts`, `tools/documents.ts`.
- **Document export.** Markdown → PDF (Chromium `printToPDF`) and → DOCX (pure JS). `src/main/export/`, `tools/export.ts`. Docs: [export.md](export.md).
- **Slides render.** `render.htmlToPdf` core tool with layout validation. `src/main/tools/render.ts`, `htmlPdf.ts`.
- **DOCX review.** Main-process read/annotate tools plus .NET sidecar. `src/main/docx/`, `tools/documents.ts`, `sidecar/docx-worker/`. Docs: [docx-review-workflow.md](docx-review-workflow.md).
- **References.** BibTeX parsing, bibliography resolution, citeproc export. `src/main/tools/references.ts`, `export/citations.ts`.
- **Inline comments.** `<comment>`/`<note>` tags in markdown, `@mim` line markers in code files; parser/tools/CM6 extension/review rail. `src/main/comments/`, `tools/comments.ts`.
- **Logbook.** Optional `.mim/log.md` activity log, `{{PROJECT_LOG}}` in system prompt. `src/main/logbook.ts`, `tools/logbook.ts`. Docs: [logbook.md](logbook.md).

### Main Process — App System

- **App runtime.** Backend jobs, app data, JSON Schema tool input validation, per-package app-tool serialization, agent descriptor parsing, `ctx.http` (host allowlist), `ctx.secrets` (keychain), named tools. `src/main/packages/packageRuntime.ts`, `packageJobs.ts`, `packageData.ts`, `packageHttp.ts`, `packageSecrets.ts`, `namedPackageTools.ts`. Docs: [app-system-api.md](app-system-api.md).
- **App discovery and activation.** Direct Mim, Team, and Project roots with Project > Team > Mim precedence, local per-Project activation, permission review, and live rescans. `src/main/packages/packages.ts`, `packageEnablement.ts`, `tools/coreApps.ts`, `tools/packages.ts`. Docs: [app-system-api.md](app-system-api.md), [custom-apps.md](custom-apps.md).
- **Core-app tools.** `app.status/enable/disable/trust` for local activation and permission review. `src/main/tools/coreApps.ts`.
- **App authoring.** Starter templates, create/validate/reload authoring loop. `src/main/tools/packages.ts`, `templates/appTemplates.ts`.
- **App TUI host.** Loads an enabled app's manifest-declared `tui/` entry in the interactive headless CLI, supplies the shared terminal toolkit, and attributes calls to the app identity so the ordinary manifest gate remains in force. `src/main/tui/packageTui.ts`.
- **App server.** Express + WebSocket for desktop app/AI/MCP routes, SDK file serving, and app/MCP tool dispatch. `src/main/server/server.ts`.
- **App SDK.** WebSocket client for iframes. `sdk/mim.js`, `sdk/tokens.css`.
- **Skills and instructions.** One authored catalog with Project > Personal > Team > Mim precedence, per-user toggles, You/Project/Team creation, managed normal-editor paths, app-bundled skills, progressive tool gating, revision-safe Personal skill creation/update, and Mim → Team → Personal → Project instruction composition. Personal and Project instruction links live with their owning Settings sections. `src/main/skills.ts`, `ai/instructions.ts`, `ai/systemPrompt.ts`, `tools/skills.ts`. UI: `SkillsSettingsPanel.vue`, `GeneralSettingsPanel.vue`, `ProjectSettingsPanel.vue`, Chat skill chips. Docs: [skills.md](skills.md), [custom-apps.md](custom-apps.md).

### Main Process — Integrations

- **Slack & Google.** Keychain-backed connectors, Google browser OAuth, kernel tools, AI tool builders, and Settings > Tools availability policy. Slack also has routine-listener runtime: bot/app-token credential tools, one-shot capability-based bot setup/check tools, Socket Mode listener lifecycle, metadata-only event ledger, durable Slack thread-to-Mim-session routing, routine dispatcher, and bot thread replies. Data tools are exposed over MCP when connected and enabled. AI agent can manage connection lifecycle (connect, disconnect, configure policy) via `connections_status`, `google_set_oauth_client`, `google_connect`, `slack_connect`, `slack_bot_connect`, `slack_bot_setup`, `slack_bot_check`, `connections_configure` tools. File-based credential ingestion reads secrets server-side so they never enter model context. `src/main/integrations/`, `src/main/tools/toolPolicy.ts`. Docs: [integrations.md](integrations.md).

### Main Process — Observability

- **Trace stream.** Optional local audit + observability, span-tree JSONL day files, caller/principal attribution, compressed content-addressed payloads with independent retention/budget, and outcome tracking. Workspace exposes a simple on/off control; disabling purges and suppresses local storage, while technical controls live under Advanced. `src/main/trace/`, `tools/trace.ts`. UI: `StorageSettingsPanel.vue`. Docs: [observability.md](observability.md).
- **Telemetry.** Anonymous usage telemetry, redacted trace-sink projection. `src/main/telemetry/`, `tools/telemetry.ts`. Docs: [telemetry.md](telemetry.md).
- **Search.** SQLite FTS5 for sessions, async file content walker. `src/main/search/`.

### Renderer — Surfaces

- **Chat.** AI SDK Chat + DefaultChatTransport, message rendering, context-compaction divider/status row, composer with @mentions and context chips, inline approval cards, code-run card. `src/renderer/components/chat/`, `services/ai/`, `stores/approvals.ts`, `components/chat/ChatCodeRunCard.vue`.
- **Editor / Document pane.** Unified tab host: CodeMirror text, PDF viewer, table grid (AG Grid), file cards. Autosave, conflict bar, per-tab scroll restore, inline AI (Cmd+K), diff review, comments rail, citations, ghost completions. `src/renderer/components/editor/`. Docs: [document-pane.md](document-pane.md), [comments.md](comments.md).
- **CodeMirror extensions.** Setup, formatting, citations, outline, ghost, live preview (single-line viewport decorations plus state-backed image/table widgets), inline anchor, send-to-terminal (Cmd+Enter / chunk send). `src/renderer/components/editor/codemirror/`.
- **Terminal.** xterm.js multi-tab shells, TerminalSurface shared with agent sessions. `src/renderer/components/terminal/`.
- **Files.** Work-side file browser: Browse/Recent/Changed, fetched Project + Team Git changes with author and commit summary, search, drag-drop import/move, multi-select (cmd/ctrl+click, shift+click) with bulk move/delete, context menus, passive active-document marker, image artifact viewer. `src/main/tools/awareness.ts`, `src/renderer/components/files/`, `services/fileOpenPolicy.ts`, `components/files/ImageArtifact.vue`.
- **History.** Browse active/archived sessions, app runs, agent sessions. `src/renderer/components/archive/`.
- **Agent sessions.** Work surface for live terminal or scrollback replay. `src/renderer/components/agents/AgentSessionView.vue`.
- **Pop-out editor windows.** Move any editor tab into its own OS window and back. Ack'd handshake tab transfer, per-window close guards, aggregate quit guard, focused-window menu routing, terminal/chat forwarding, theme/settings live-sync, macOS native document-edited/represented-filename, `editor.open` routing to the owning pop-out. `src/main/windows/popoutWindows.ts`, `src/renderer/popout.html`, `src/renderer/popout.ts`, `src/renderer/components/popout/PopoutShell.vue`. Docs: [document-pane.md](document-pane.md) (pop-out section).

### Renderer — Shell & Navigation

- **Sidebar / Navigator.** Workspace switcher, fixed surface rows (Chat/Files/Terminal/Monitor), collapsible Apps + Activity sections, 52px collapsed rail. `src/renderer/components/sidebar/`.
- **Workbench state.** Work/Artifact entries, pane history, layout invariants, dirty replacement guard. `src/renderer/stores/workbench.ts`, `services/workbench/`. Docs: [workbench-navigation.md](workbench-navigation.md), [workbench-layout.md](workbench-layout.md).
- **App shell.** Composition shell, tested adapters for routing/lifecycle/keyboard. `src/renderer/App.vue`, `services/appShell/`, `components/workbench/`.
- **Command palette.** Cmd/Ctrl+P: files, sessions, surfaces, actions. `src/renderer/components/CommandPalette.vue`, `services/commandPalette.ts`.

### Renderer — Stores & Services

- **Sessions store.** Session state, filtering, draft persistence, status tracking, and forced post-turn usage/context refresh. `src/renderer/stores/sessions.ts`.
- **Settings store.** Theme, editor prefs, model defaults, key status, and simple local-record toggles backed by Advanced history/trace storage policies. `src/renderer/stores/settings.ts`.
- **Runs store.** Aggregated chat/app/agent status for Navigator. `src/renderer/stores/runs.ts`.
- **Pings store.** Per-row "ping when done" opt-in: watches run status transitions, plays a synthesized chime, tracks fired-ping state for row indicators. `src/renderer/stores/pings.ts`, `services/pingSound.ts`.
- **Resolved apps store.** Per-app enabled/visible/installed state. `src/renderer/stores/coreApps.ts`.
- **Model controls.** Chat/inline/ghost model selection. `src/renderer/services/ai/modelControls.js`.

### Renderer — Settings

- **Settings dialog.** Dense fixed-size dialog organized by ownership: YOU (General, AI & Models, Connections), WORK (Team, Project, Apps & agents, Skills), and ADVANCED (Tools). Personal and Project instructions open in the normal editor from their owner sections; the footer owns Mim version and updater state. `src/renderer/components/settings/`.

### Renderer — Shared UI

- **UI primitives.** `MimDialog`, `MimSelect`, `MimMenu`/`MimMenuItem`, `MimContextMenu`, `MimSegmented`, `MimToggle`. `src/renderer/components/ui/`. See [design-system.md](design-system.md) §6.
- **Themes.** Light (white/parchment/glacier/sage) + dark (slate/monokai/nord/dracula) via `data-theme`. `src/renderer/styles.css`.
- **Toast store.** Global error/info notifications. `src/renderer/stores/toasts.ts`, `components/ToastHost.vue`.

### Optional Team Repositories

Each company may maintain a separate Team repository with apps under
`apps/<id>/` and a generated `team-index.json` release boundary. Core has no
company app catalog. `scripts/team-compat.test.ts` stages every indexed Team
app into the real loader/runtime, named-tool path, and app-root `compat.mjs`
hooks. The Team repository owns its validation, version bumps, index
generation, and current-Mim compatibility workflow.

### Documentation Pipeline

- **Docs generators.** Deterministic scripts generate shortcuts, models, and the core tool catalog from source data. Optional company apps are not published in the core manual. `scripts/docs-gen/`. Run via `npm run docs:gen` (requires `npm run build` for the tool catalog).
- **Claim lint.** Validates manual page claims (tool names, shortcuts, settings refs, internal links) against source of truth. `scripts/docs-lint.mjs`. Run via `npm run docs:lint`.
- **Continuous verification.** Core pushes and pull requests run the full suite, production build, generated-doc drift check, and claim lint. Each Team runs its app tests and the generic current-Mim Team compatibility harness in its own workflow. `.github/workflows/test.yml`.

### Docs Index

| Doc | What it covers |
|---|---|
| [ontology.md](ontology.md) | Canonical concepts and naming laws (draft, under review) |
| [vocabulary.md](vocabulary.md) | Vocabulary migration decisions and execution waves (draft) |
| [gotchas.md](gotchas.md) | Non-obvious constraints and lessons |
| [code-execution.md](code-execution.md) | Code execution, toolchain detection, interpreter allowlist |
| [security.md](security.md) | Permission gate, trust model, actor modes |
| [design-system.md](design-system.md) | Visual language, tokens, interaction rules |
| [cli.md](cli.md) | Headless CLI commands |
| [mcp.md](mcp.md) | Local MCP stdio bridge to the running desktop |
| [integrations.md](integrations.md) | Slack/Google tools, keychain, policy |
| [web-reading.md](web-reading.md) | Web/PDF reading, website access, evaluation harness |
| [html-markdown.md](html-markdown.md) | HTML-to-Markdown parser |
| [history.md](history.md) | Local file recovery |
| [git.md](git.md) | Git tools and managed sync |
| [team.md](team.md) | Simple Team setup, fixed repository contract, activation model, checkout, sync, safety, and troubleshooting |
| [export.md](export.md) | PDF/DOCX export pipeline |
| [document-pane.md](document-pane.md) | Editor surface architecture |
| [comments.md](comments.md) | Inline review comments (markdown + code) |
| [observability.md](observability.md) | Trace stream, audit, outcomes |
| [telemetry.md](telemetry.md) | Anonymous usage telemetry |
| [logbook.md](logbook.md) | Human-readable activity log |
| [routines.md](routines.md) | Routine definition lifecycle, activation, automation triggers, runs, and permissions |
| [subagents.md](subagents.md) | Durable delegated threads, communication, scheduling, authority, persistence, and Navigator behavior |
| [skills.md](skills.md) | Filesystem skill system |
| [custom-apps.md](custom-apps.md) | Building Project and Team apps/skills |
| [granola-private-app.md](granola-private-app.md) | Private Granola app rationale, implementation, and operations |
| [app-system-api.md](app-system-api.md) | App system contract and author API |
| [package-runtime.md](package-runtime.md) | App runtime architecture |
| [docx-review-workflow.md](docx-review-workflow.md) | DOCX review workflow |
| [auto-update.md](auto-update.md) | App auto-update and release builds |
| [agent-sessions.md](agent-sessions.md) | CLI agent sessions |
| [workbench-navigation.md](workbench-navigation.md) | Navigator/Work/Artifact pane model |
| [workbench-layout.md](workbench-layout.md) | Layout handoff for agents |
| [activity-review-rethink.md](activity-review-rethink.md) | Monitor surface design rationale |
| [brand/README.md](brand/README.md) | Logo toolkit and brand assets |

### Proposals

Open proposals only. Implemented proposals are deleted once their content is
reflected in the current-state docs; git history retains them.

- [proposals/ai-native-browser.md](proposals/ai-native-browser.md) — two-layer web access plan: cheap reader plus AI-native live browser with bounded observations and compact action refs.
- [proposals/tools-settings-tab.md](proposals/tools-settings-tab.md) — Settings > Tools plan for unified AI/MCP tool availability policy.
- [proposals/routines.md](proposals/routines.md) — Routines: workspace-owned standing prompts that create runs; desktop starts stream through the normal chat transcript, headless scheduler runner, visible tools plus approval grants, scheduler ownership.
- [proposals/slack-transport.md](proposals/slack-transport.md) — proposed clean break: Slack as a first-class transport to the workspace's default Mim agent, with one standing-consent decision per enabled channel, durable threaded conversations, full normal tool/subagent utility, and no Slack-specific permission system.

## File Tree

```
src/
  main/                         # Electron main process
    index.ts                    # Boot, window, IPC handlers
    autoUpdater.ts              # electron-updater
    cli.ts                      # Headless CLI commands
    headless.ts                 # Non-Electron tool registry boot
    tui/packageTui.ts           # App-owned terminal interface host
    sessions.ts                 # Session CRUD (JSON files)
    sessionManifest.ts          # Lightweight sessions cache
    userConfig.ts               # ~/.mim/config.yaml loader
    skills.ts                   # Filesystem SKILL.md loader
    menu.ts                     # Native application menu
    platform.ts                 # Cross-platform helpers
    pty.ts                      # Terminal spawning (node-pty)
    ptyCommand.ts               # Windows .cmd/.bat wrapping
    ptyShellIntegration.ts      # Scratch-zsh keymaps
    logbook.ts                  # .mim/log.md activity log
    htmlPdf.ts                  # Hidden-BrowserWindow HTML→PDF
    closeGuard.ts               # Quit guard decision
    atomicJson.ts               # Atomic JSON file writes
    history/history.ts          # Local per-file recovery store
    toolchain/
      toolchain.ts              # Binary detection, version, promise cache
    agents/
      agentCatalog.ts           # CLI agent detection
      agentResources.ts         # Spawn-safe bundled resource resolution
      agentSessions.ts          # Session lifecycle + persistence
      agentStatus.ts            # Idle-first PTY lifecycle + blocking-input tracker
    ai/
      ai.ts                     # Model registry, key resolver
      aiRuntime.ts              # Central AI runtime + tools
      compaction.ts             # Model-context view repair and compaction
      agentContext.ts           # Runtime workspace digest
      agentMounts.ts            # App agent → AgentProfile resolution
      systemPrompt.ts           # Dynamic AI system prompt
      workspaceTree.ts          # Bounded workspace tree prompt context
    packages/
      packages.ts               # App loader
      packageManifest.ts        # Manifest validation
      packageEnablement.ts      # Personal enablement + trust
      packageRuntime.ts         # Backend capability loader
      packageJobs.ts            # App job runner
      packageData.ts            # App-scoped JSON storage
      packageHttp.ts            # ctx.http host allowlist
      packageSecrets.ts         # ctx.secrets keychain
      namedPackageTools.ts      # Named app tools as registry tools
      packageContributions.ts   # Agent-context contributions
      cacheLayout.ts            # ~/.mim/cache/ layout
      semver.ts                 # Strict semver helpers
    mcp/
      stdio.ts                  # MCP stdio bridge
      discovery.ts              # ~/.mim/server.json helpers
    team/
      teamSource.ts             # One Team connection, check/publish/update Git lifecycle
      teamRelease.ts            # Release index parsing + human change comparison
      teamReleaseContents.ts    # Release digest/access integrity verification
      teamFiles.ts              # Safe Project checkout mount + Team Files root
      liveTeamRefresh.ts        # Refresh apps/tools/routines after accepted updates
    sync/
      backgroundSync.ts         # Open/save/quit sync lifecycle and offline retry
      conflicts.ts              # Rebase conflict-copy preservation + stop state
    search/
      search.ts                 # SQLite FTS5 session search
      fileSearch.ts             # Workspace file content search
      textMatch.ts              # Deterministic text matching
    routines/
      routines.ts               # Routine definitions, revisions, trigger validation, activation/run state
      automation.ts             # Schedule/file/webhook automation, watcher roots, webhook verification
    security/
      gate.ts                   # Permission gate
      gate-paths.ts             # Path classifier
    server/server.ts            # Express + WebSocket server
    windows/
      popoutWindows.ts          # Pop-out window registry, pure decision helpers
    workspace/
      workspaceBoot.ts          # Last-workspace restore
      workspaceContract.ts      # mim.yaml schema/parser/scaffold
      workspaceFileWatcher.ts   # File-change events
    integrations/
      secrets.ts                # OS keychain boundary
      http.ts                   # HTTP boundary
      slack/                    # Slack client/tools plus Socket Mode routine listener, ledger, thread sessions, and dispatcher
      google/                   # Google client, tools, AI tools, policy
    comments/model.ts           # Markdown inline comment parser
    comments/codeModel.ts       # @mim line-marker comments for code files
    comments/dispatch.ts        # Path-aware routing between the two models
    html/markdown.ts            # HTML-to-Markdown parser
    documents/
      importMarkdown.ts         # DOCX/XLSX/BIB/PDF → Markdown
      pdfExtract.ts             # PDF text extraction
    docx/                       # DOCX read/annotate helpers
    export/                     # PDF/DOCX export pipeline
    trace/
      trace.ts                  # Trace stream writer
      query.ts                  # Trace query/stats
      outcomes.ts               # Edit outcome tracker
    telemetry/                  # Anonymous usage telemetry
    tools/
      registry.ts               # Tool registry + dispatch
      fs.ts                     # File operations
      history.ts                # File history tools
      git.ts                    # Git tools
      awareness.ts              # Fetched Project + Team changes and authors
      sync.ts                   # Managed sync tools
      team.ts                   # Team connection/status/open/sync tools
      workspace.ts              # Workspace tools
      bridge.ts                 # Cross-surface messaging
      editorState.ts            # editor.state open-tab snapshot
      packages.ts               # App authoring tools
      coreApps.ts               # App enablement tools
      documents.ts              # DOCX/PDF/import tools
      export.ts                 # PDF/DOCX export tools
      render.ts                 # HTML→PDF render tool
      web.ts                    # Web read/search tools
      search.ts                 # Search dispatcher
      agents.ts                 # Agent session tools
      archive.ts                # History/archive tools
      settings.ts               # Settings persistence
      skills.ts                 # Skill tools
      logbook.ts                # Logbook tools
      trace.ts                  # Trace query tools
      toolPolicy.ts             # Settings > Tools availability policy
      toolchain.ts              # toolchain.status tool
      code.ts                   # code.run + shell.run execution tools
      comments.ts               # Comment tools
      references.ts             # Bibliography tools
      routines.ts               # Routine definition/manual run/webhook secret tools
      telemetry.ts              # Telemetry tools
    templates/
      appTemplates.ts           # Starter app scaffolds
      skillTemplates.ts         # Starter skill scaffolds

  preload/index.ts              # IPC bridge: window.kernel

  renderer/                     # Vue 3 SPA
    App.vue                     # Composition shell
    main.ts                     # Vue app mount
    popout.html                 # Pop-out editor window entry (multi-page Electron)
    popout.ts                   # createApp(PopoutShell) + Pinia
    styles.css                  # Tailwind, tokens, themes
    styles.contrast.test.ts     # WCAG contrast contract for all 8 themes
    stores/
      sessions.ts               # Session state + filtering
      settings.ts               # Personal preferences + Project runtime settings
      workbench.ts              # Work/Artifact navigation state
      diff.ts                   # Editor diff review state
      approvals.ts              # Permission-request queue
      runs.ts                   # Aggregated run status
      pings.ts                  # Ping-when-done chime + indicators
      agents.ts                 # CLI agent catalog mirror
      appAgents.ts              # App-mounted agent state (package agents)
      coreApps.ts               # Resolved per-app state
      toasts.ts                 # Toast notifications
    services/
      ai/
        modelControls.js        # Model selection + defaults
        ghost.js                # Ghost completions client
        taskLabel.js            # Sidebar task labels
        errors.js               # AI error mapping
      appShell/                 # Tested shell adapters
      workbench/
        entries.ts              # Work/Artifact entry types
        history.ts              # Pane-history primitive
        commands.ts             # Command router
        hosts.ts                # Host resolvers
        keyRouter.ts            # Keyboard action router
        landingDecision.ts      # Boot surface decision
        artifactReplacement.ts  # Dirty-state guard
      attachments.js            # Attachment normalization
      pingSound.ts              # Web Audio completion chime
      approvalDiff.ts           # Approval preview content
      lineDelta.ts              # Added/removed line counts (LCS)
      currentDocument.js        # Active document bridge
      fileOpenPolicy.ts         # Editor vs native open
      renderDocument.ts         # Rmd/qmd render engine matrix
      toolchainStatus.ts        # Cached toolchain status (renderer)
      fuzzy.ts                  # Fuzzy scorer
      commandPalette.ts         # Palette sources + ranking
      shortcutLabels.ts         # Platform shortcut labels
      workspaceFileIndex.ts     # Cached file index
      citationHealth.ts         # Citation status
      comments/sendToChat.ts    # Comments → chat handoff
      sessionExport.ts          # Chat JSON export
    components/
      chat/
        ChatView.vue            # Main chat surface
        ChatMessage.vue         # Message rendering
        ChatTurnStatus.vue      # Non-persisted pre-stream context status row
        ChatCodeRunCard.vue     # bash result card
        chatCodeRunCard.ts      # Run card view-model
        ChatComposer.vue        # Input + context chips
        InlineApproval.vue      # Inline permission card
        ModelPicker.vue         # Model dropdown
      editor/
        EditorPanel.vue         # Document tab host
        InlineAI.vue            # Cmd/Ctrl+K surface
        DiffReviewBar.vue       # Diff review toolbar
        DiffView.vue            # CodeMirror merge view
        HistoryRail.vue         # Go Back rail
        EditorTabStrip.vue      # Tab navigation
        EditorToolbar.vue       # Format buttons
        PreviewPane.vue         # Live markdown preview
        comments/               # Comment rail + cards
        codemirror/             # CM6 extensions
          sendToTerminal.js     # Cmd+Enter / chunk send logic
      terminal/
        TerminalPanel.vue       # Multi-tab shells + program tabs
        TerminalSurface.vue     # Single xterm ↔ pty
        terminalSendText.ts     # Line-joining for terminal send
      files/
        FilesWorkView.vue       # File browser orchestrator
        FilesTable.vue          # File rows
        ImageArtifact.vue       # Image viewer tab
        TableArtifact.vue       # CSV/TSV grid
      sidebar/
        ShellSidebar.vue        # Navigator orchestrator
        WorkspaceSwitcher.vue   # Workspace popover
        SessionRow.vue          # Chat activity row
        RunRow.vue              # App run activity row
      workbench/
        WorkbenchShell.vue      # Pane shell slots
        WorkHost.vue            # Work surface host
        ArtifactHost.vue        # Artifact surface host
        PaneHeader.vue          # Pane header controls
      popout/
        PopoutShell.vue           # Pop-out editor window shell
      agents/AgentSessionView.vue  # Agent session Work surface
      archive/ArchiveBrowser.vue   # History Work surface
      packages/PackageFrame.vue    # App iframe host
      settings/
        SettingsDialog.vue      # Settings shell
        sections.ts             # Section id protocol
        AppsSettingsPanel.vue   # Mim/Team/Project apps + CLI agents
        AiSettingsPanel.vue     # Keys + model defaults
        ConnectionsSettingsPanel.vue  # Integrations + website access
        ToolsSettingsPanel.vue  # Agent tool availability policy
        codeInterpreterRows.ts  # Interpreter toggle row logic
      ui/                       # MimDialog, MimSelect, MimMenu, MimContextMenu, etc.
      CommandPalette.vue        # Cmd/Ctrl+P palette
      AddProjectDialog.vue      # Open/New/Clone workspace
      InitWorkspaceBanner.vue   # Workspace init offer

sdk/
  mim.js                        # WebSocket app SDK
  tokens.css                    # App design tokens

resources/
  ai-models.json                # Model catalog
  pi/mim-extension.mjs          # Direct Pi tool + lifecycle adapter
  r/mim-run.R                   # Plot-capture harness for code.run
  icon.png                      # macOS dev dock icon

skills/
  build-app/SKILL.md            # Smallest-abstraction app/skill authoring workflow

scripts/
  docs-gen/                     # Manual documentation generators
    index.mjs                   # Orchestrator — runs all generators
    toolCatalog.mjs             # Tool catalog from headless registry + gate.ts
    shortcuts.mjs               # Shortcuts from ShortcutsDialog.vue
    models.mjs                  # Models from resources/ai-models.json
  team-compat.test.ts           # Optional Team apps against the real runtime
  docs-lint.mjs                 # Claim lint for manual pages

manual/
  _style.md                     # Voice + design rules contract
  _specs/                       # One spec per chapter: outline + sources
  _generated/
    shortcuts.md                # Generated shortcuts fragment (include)
  develop/
    tools.md                    # Generated tool catalog
    models.md                   # Generated models page

docs/                           # Implementation docs (see Docs Index above)
```

## Branding

- Product name: **Mim**. Internal package: `mim`.
- Project contract: `mim.yaml` + `AGENTS.md` + `CLAUDE.md`. Runtime (gitignored): `.mim/`.
- Personal: `~/.mim/config.yaml` (identity, preferences, model defaults, skill activation — no secrets). Keys: `~/.mim/keys.env`. Integration tokens: OS keychain.

## Maintenance

- When adding a subsystem, add a row under Systems and update the file tree.
- Keep entries concise and source-linked. Do not duplicate code or doc content here.
