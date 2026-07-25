# Gotchas

Non-obvious constraints. Add to this whenever a fix depends on a subtle rule.

## AI SDK: inputSchema, not parameters

When defining tools with the Vercel AI SDK `tool()` function, always use `inputSchema`, never `parameters`. Using `parameters` silently breaks Anthropic (400 error: `input_schema.type: Field required`). `src/main/ai/aiSdkToolContract.test.ts` enforces this for production `src/main` files that import `tool` from `ai`.

## @ai-sdk/vue Chat state is reactive — never poll it

`@ai-sdk/vue`'s `Chat` keeps `messages`, `status`, and `error` in Vue refs (`VueChatState` in `node_modules/@ai-sdk/vue/dist/index.js`). Reading `chat.messages`/`chat.status`/`chat.error` inside a `computed`/template/`watch` is fully reactive, including streaming — `pushMessage` reassigns `.value` and `replaceMessage` mutates the reactive array in place; both notify dependents. Do **not** add `setInterval`/tick hacks to "force" reactivity (an earlier `ChatView.vue` did this). The only genuinely non-reactive piece is the plain `Map` of per-session `Chat` instances, so the active chat is surfaced through a `shallowRef` (`activeChatRef`) that `getOrCreateChat` assigns. `chatReactivity.test.ts` guards the streaming mutation patterns.

Build the `Chat` only after its session's history is loaded: `getOrCreateChat` awaits `sessionStore.ensureMessages(id)` before `new Chat({ messages })`, so an engine is never born empty for a session that has persisted messages (the old "chat is empty until you send a message" bug). `session.list` strips messages, so the store tracks hydrated ids to fetch each session's history exactly once.

The main AI runtime persists final usage and context metadata before the chat
stream closes. The renderer must therefore await the `Chat` turn and then call
`sessionStore.refresh(id)` to merge that persisted metadata into Pinia. Do not
use `ensureMessages(id)` for this: its hydration cache intentionally skips
already-loaded sessions, which leaves cost and context stale after a turn.
`ChatView.vue` centralizes this ordering in `runTurnAndRefreshSession` for sends,
retries, queued routine turns, and start-fresh seed turns. Refresh failure is
logged but must not replace the model turn's own result.

## Token cost is a provider-aware estimate, not a token-total multiplier

`normalizeSdkUsage()` prices the usage categories reported by the AI SDK
separately: uncached input, cache reads, cache writes, and output. An explicit
zero in `resources/ai-models.json` is a real zero; do not replace it with the
base input rate. Models with provider billing tiers also carry
`longContextThresholdTokens`, `longContextInputMultiplier`, and
`longContextOutputMultiplier`, which apply to the whole model call after its
reported input crosses the threshold.

Anthropic requests currently use `cacheControl: { type: 'ephemeral' }` without
a TTL, so their catalog cache-write rate is the five-minute rate. If the app
starts requesting one-hour caches, the usage path and catalog must distinguish
that more expensive write tier. Claude Fable 5 also reports tokens for a
pre-output refusal even though Anthropic does not bill them; the estimator uses
the SDK's `content-filter` finish reason plus zero output to preserve the usage
counts while recording zero cost. Mid-stream refusals remain billable.

Catalog contract tests in `src/main/ai/ai.test.ts` pin published context windows,
Fable pricing, and long-context tiers. Estimator tests in
`src/main/ai/aiRuntime.test.ts` cover category pricing, explicit zero rates,
long-context multipliers, and Fable refusals. The displayed amount remains an
estimate: account discounts, taxes, provider credits, and provider-side add-on
fees outside reported model-token usage are not included.

## Trace grouping: thread the turn traceId, or you get orphan Activity runs

The Activity feed groups one run per `traceId` (`feedRuns` in `ActivityTrustView.vue`). Any `tools.call` made on behalf of a chat turn that does **not** carry the turn's `{ traceId, spanId }` in its `ToolContext` starts a fresh trace and therefore shows up as its own feed row. This is what made a single chat send look like 20+ unrelated activities: the pre-flight `skill.list`/`package.tools.list` and the closing `session.update` persistence ran with no trace context. The `chat.turn` root span is now created up front (`streamProfileResponse`) and threaded into all per-turn helpers, including context-compaction summary checks, overflow retry, and compaction record writes. When adding any new per-turn helper call, pass the turn trace.

Single-shot housekeeping model calls (ghost, task-label, summary) are genuinely separate renderer-initiated requests, so they cannot inherit the turn trace — and the task-label deliberately uses the cheap `extract` model (this is why a sonnet chat showed a stray "haiku" `model.call`). They are filtered out of the feed by `run.kind === 'model'` (a run rooted on a bare `model` span) but stay in Health cost aggregation and the Timeline. Do not "fix" the haiku entry by forcing the chat model onto label generation — that is intended cost savings.

## Editor: dirty and externalState are separate facts

`useEditorFileSync.ts`'s `markTabChangedOnDisk`/`markOpenTabChangedOnDisk` set `tab.externalState` (drives the ConflictBar) but must **not** force `tab.dirty = true`. Dirty means "buffer differs from the last save" and drives close-confirmation prompts and the quit guard; externalState means "disk moved out from under this tab" and is fully recoverable (OS Trash, `.mim/history`). Conflating them made every external change — including ones the user caused themselves via the Files pane delete — falsely claim "unsaved changes" on a clean buffer. See [document-pane.md](document-pane.md) External Changes and Deletion section for the full user-delete-vs-external-delete split.

## Native modules require electron-rebuild

`better-sqlite3` and `node-pty` are native Node addons. After `npm install`, `electron-rebuild` runs via the `postinstall` script. If you add another native module, it must be rebuilt too or Electron will crash at runtime with a `NODE_MODULE_VERSION` mismatch.

## xterm line-boundary shortcuts are platform-specific

xterm.js deliberately drops arrow keys with `metaKey` on macOS, so Cmd+Left/Right never reaches the PTY as line-boundary movement. Keep macOS terminal text-navigation shims in `src/renderer/components/terminal/terminalKeybindings.ts`, where they can be tested as raw byte mappings before xterm handles the event.

On Windows and Linux the same shim is Ctrl+Left/Right, not Super/Meta+Arrow. Keep the platform branch in `terminalKeybindings.ts`; otherwise Linux users cannot trigger the documented line-boundary shortcut.

Terminal Shift+Enter and Option-arrow behavior are profile-specific. Scratch zsh terminals use the `terminal-zsh` renderer profile: Shift+Enter writes `CSI 13;2u`, which `ptyShellIntegration.ts` binds to a `mim-insert-newline` ZLE widget so the next plain Enter still accepts the whole shell buffer. Non-integrated scratch shells keep the legacy `\x16\n` (`quoted-insert` plus LF) fallback. macOS Option+Left/Right and Option+Shift+Left/Right must be intercepted and written as explicit xterm modified cursor sequences (`CSI 1;3D/C` for both, because shell line editing does not support macOS-style selection here); do not rewrite them to `Esc+b`/`Esc+f`, and do not rely on xterm's macOS Option text-modifier path to choose the bytes. Raw `Esc` word movement assumes an emacs/readline keymap and can switch zsh vi insert mode into command mode, where the next `x`, `u`, `b`, or `f` is interpreted as an editor command.

Scratch zsh terminals get their compatibility at shell startup. `terminal.spawn` opts into `ptyShellIntegration.ts`, which points zsh at a generated `ZDOTDIR`, sources the user's original `.zshenv`/`.zshrc`, then binds Shift+Enter's `CSI 13;2u` multiline widget, plain left/right arrows and backspace/delete for editable multiline buffers, xterm Option/Alt arrows, Home/End variants, Cmd+Arrow fallback bytes (`^A`/`^E`), and Option+Backspace (`^W`) in both `emacs` and `viins` keymaps. Keep this integration opt-in for scratch terminals only; agent sessions also use `spawnPtyProcess`, but they must not inherit shell startup shims.

Agent terminal surfaces use their agent id as the `TerminalSurface` keybinding profile. Agent Shift+Enter falls back to `\x1b\r` (Alt+Enter), matching the terminal setup guidance used by modern agent CLIs. Agent Cmd+Left/Right sends Home/End (`\x1b[H`/`\x1b[F`) instead of shell readline bytes. For agent profiles, do not rewrite macOS Option+Left/Right to readline `Esc+b`/`Esc+f`; xterm already emits standard modified cursor sequences for Alt/Option arrows, while raw-mode agent editors may parse Alt-letter commands as destructive editor actions.

Mim does not currently advertise Kitty/CSI-u keyboard protocol support. Do not respond to `CSI ? u` or enter enhanced keyboard mode unless the terminal layer encodes the whole key family it advertises; half-implementing only Shift+Enter leaves Option/Cmd arrows and deletion in an inconsistent parser mode.

## xterm startup needs a visible, measurable parent

xterm measures DOM geometry during `terminal.open(parent)`, and its parent must already be visible with nonzero dimensions. The scratch terminal is lazy-mounted through WorkHost and then kept under `v-show`, so opening xterm during the first mount can leave the helper textarea/input layer inert until a later hide/show or tab switch forces layout. `TerminalSurface.vue` therefore waits for an active, measurable container before calling `terminal.open()`, buffers PTY output until then, and refits/focuses when the terminal Work surface becomes visible again. Keep startup/visibility fixes in `TerminalSurface.vue` plus the WorkHost/TerminalPanel active prop path, not as incidental tab-switch side effects.

## Terminal tab PTY ids must be written through reactive state

`TerminalPanel.vue` stores tabs in a Vue reactive array. After pushing a new tab, do not keep mutating the original plain object across an `await` and expect the template to update; resolve the live tab from `tabs.value` before writing async results like `ptyId`. Otherwise `terminal.spawn` can succeed and the PTY can emit output while `TerminalSurface` still receives `ptyId=null`, so it never subscribes until an unrelated hide/show forces a rerender. `TerminalPanel.test.ts` guards that the spawned PTY id reaches the active surface immediately.

## Cross-platform home, shell, and display paths

Do not read `process.env.HOME` directly and never fall back to a literal `~`. Use `userHomeDir()` in `src/main/platform.ts`, which honors `HOME`, then `USERPROFILE`, then `os.homedir()`.

Do not hardcode `/bin/zsh` outside macOS behavior. Use `defaultShell()` so Windows gets `ComSpec`/`cmd.exe`, Linux gets `$SHELL` or `/bin/sh`, and macOS keeps `/bin/zsh` as the final fallback.

Any path sent to the renderer, agent transcript, search result, or tool result as a workspace-relative display path must use forward slashes via `toSlashPath()`. Actual filesystem operations still use Node path APIs. This keeps Windows `path.relative()` backslashes from breaking UI code that intentionally treats `/` as the display-path separator.

## Main-process resources move after build

Do not resolve bundled resources from a single `import.meta.dirname` path. Electron-vite can place shared main code in `out/main/chunks/`, so `../../resources` from that file points at `out/resources`, not the repo or packaged app resources. Use a multi-root resolver like `resolveRegistryPath()` in `src/main/ai/ai.ts`, and smoke-test built output when changing resource lookup.

The app iframe SDK has the same constraint. `/sdk/mim.js` and
`/sdk/tokens.css` are served by the local app server from `sdk/`, and they must
be included in `electron-builder.config.mjs` `files`. If they are missing from
the packaged app, every app iframe loads HTML 404 pages for the SDK assets:
`mim.js` 404s and `tokens.css` is rejected for `text/html` MIME type.

## Package server port is dynamic

`src/main/server/server.ts` binds to port 0 (OS-assigned random port). The renderer gets the port via `window.kernel.getPort()`. Package iframes discover it from their own URL. Never hardcode a port number.

## MCP allowlist belongs in the desktop server

`mim mcp` exposes only a curated tool surface, but the stdio process is not the
security boundary. Any local process with the bearer token from
`~/.mim/server.json` can speak to the desktop WebSocket directly. Keep the MCP
allowlist enforced in `src/main/server/server.ts` before `tools.call()`, and
keep `__meta.tools` MCP-only and identified-only. The stdio bridge may mirror
the map for DX, but it must not be the only restriction.

## Live-browser localhost access follows the initial target

Loopback is allowed only for `web.live.open`, and only when the URL passed to
`browser_open` is itself `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`.
Carry that decision into the session request blocker for HTTP(S) and WebSocket
requests so Vite-style HMR works. Never enable loopback globally: a browser
session opened on a public page must remain unable to probe local services, and
private LAN, link-local, cloud-metadata, and unique-local addresses stay blocked.
`web.read`, Website Access setup, and headless/serve web tools keep the default
public-only policy.

## Package launch tokens must outlive their mint window once identified

Package iframe URLs are long-lived: the work pane keeps `PackageFrame` under `KeepAlive` with a cached launch URL, and browsers reload an iframe from its existing `src` every time it is reattached to the DOM. So navigating away from a package view and back replays the **original** launch token — possibly minutes later. Launch tokens (`src/main/server/server.ts`) therefore expire only while unused: the 60s `expiresAt` window applies to tokens that never identified, and the first successful `identify` clears it so the same URL keeps re-identifying for iframe remounts and SDK reconnects. Do not reintroduce a hard token expiry; it resurfaces as intermittent package UI startup failures after >60s away. Relatedly, `sdk/mim.js` must reject `ready` when identify fails — swallowing the failure makes every later call fail with the unidentified-connection error instead of the real cause.

## Popovers in clipped chrome

Sidebar and pane popovers that can escape their parent bounds must use `Teleport` to `body`; fixed or absolute children inside overflow-hidden chrome will be clipped.

## Floating overlays must not animate position

Teleported/floating overlays start life before runtime positioning has fully settled. If their enter/leave transition uses Tailwind duration/easing without an explicit transition property, CSS transitions `all`, so floating-ui or fixed-position corrections can animate from `0,0` or a window edge to the final anchor. Keep `MimMenu` and `MimDialog` transitions opacity-only (`transition-opacity`) unless you can prove the element is already positioned before the first painted frame.

## Local Markdown Images

Do not use `file://` URLs for editor preview images. The BrowserWindow keeps Electron's default web security enabled. Local Markdown images are rendered through `fs.readImageDataUrl`, which resolves paths inside the current workspace and returns image data URLs for the renderer. The same constraint drives the PDF Artifact viewer: `PdfArtifact.vue` loads PDFs from the kernel server's GET-only `/workspace-files/<path>` route (`src/main/server/server.ts`), never from `file://`.

## CodeMirror plugin replacements stay within one line

CodeMirror decoration functions supplied by a `ViewPlugin` run after viewport
geometry is chosen, so their replace ranges must never cross a line break.
`codemirror/livePreview.js` enforces this for token-hiding replacements with
`pushSingleLineReplacement`. Markdown images and tables may span lines and must
stay in `StateField` decoration sets instead. Moving either widget back into the
viewport plugin causes `Decorations that replace line breaks may not be specified
via plugins` and can leave the newly selected tab showing the previous document's
DOM.

The editor's shared-view tab switching also requires `@codemirror/view` 6.43.6
or newer. Earlier 6.43 releases contain tile-tree corruption bugs triggered by
decoration-heavy document updates. Preserve the real-view multiline-image and
decorated-state-swap regressions in `codemirror/livePreview.test.ts` when changing
preview decorations or tab state.

## Inline comments need the CM6 protection bypass

Markdown comments are real inline tags on disk, but hidden in the editor with CodeMirror replace decorations and atomic ranges. Normal typing must not touch those hidden spans, so `codemirror/comments.js` uses `EditorState.changeFilter` to reject edits that intersect tag markup. Any programmatic operation that intentionally creates, removes, or rewrites comment tags must dispatch with `annotations: commentMutation.of(true)`; otherwise CodeMirror will block the transaction or make whole-document replacements appear to do nothing.

One cursor position can still exist at a hidden tag boundary. That is a CM6 flat-document limitation, not a parser bug. Backspace/Delete handlers redirect boundary deletes, and the accepted invariant is: anchors remain editable, hidden tag spans do not.

Comment tools in main refuse to mutate a file that is open and dirty in the editor. The renderer pushes dirty open paths to main with `pushDirtyTabCount({ count, paths })`; keep that payload shape if the quit guard or editor dirty tracking changes.

## CLI Secret Parameters

Do not document secret-bearing `mim tool` examples with tokens directly in the command line. Use `mim tool <name> --stdin` so JSON can come from a trusted local prompt or pipe without putting tokens in shell history.

Generic `mim tool` dispatch must stay on the `ai` actor and pass through the headless permission gate. Non-interactive approval-required calls are denied, TTY calls prompt, and `--yes` is the only intentional auto-approval path for trusted local automation.

## Routine state is not the routine registry

Routine definitions live in `routines/*.md` and are reported by `routine.list`
via `loadRoutineCatalog()`. Version 2 of `.mim/routines/state.json` stores only
machine-local activation, authority acknowledgements, scheduler heartbeat, and
last-run metadata; older unversioned state is intentionally ignored. An empty
`routines` object in that state file does not mean
routine files failed to load; it means no routine has been reviewed or recorded
local run state yet. For Slack bot readiness, use `slack_bot_check` instead of
inferring status from hidden runtime files.

## Search index failures are non-fatal

`initSearchDb` and `rebuildIndex` are wrapped in try/catch in `index.ts`. If SQLite fails (permissions, corrupt db), the app still boots — search just silently returns empty results.

## Trace log failures are non-fatal

`TraceLog.append()` runs before tool execution in `ToolRegistry.call()`. It must never throw: if the active workspace was deleted while the app is running, a throw from `.mim/traces/` blocks `workspace.open` and leaves the user unable to switch folders. Only create `.mim/` when the workspace root still exists, swallow sink errors, and treat audit persistence as best-effort. The same applies to `writePayload` (returns `null` instead of throwing).

## Automatic history baselines must be bounded

Electron schedules local-history baselines after boot and workspace switches. Keep those automatic calls delayed and bounded; a full synchronous `history.baseline` over a broad workspace can block main-process startup before the window becomes usable. Manual `history.baseline` can remain full-scan, but startup/switch recovery should pass scan, capture, and time limits and tolerate a `truncated` result.

## Do not reintroduce recursive workspace watchers

The main workspace file watcher must stay scoped to explicit renderer
registrations for open files. A broad Chokidar watch over a research workspace
can consume thousands of file descriptors after copied-in data, then Chromium
sandboxed iframes fail to launch. Package freshness uses separate shallow
package and `mim.yaml` watchers; do not use the main watcher as a general
workspace event bus.

## Theme attribute is data-theme, not a class

Themes are applied via `<html data-theme="white">`, not CSS classes. The app default is White (`DEFAULTS.theme` in `stores/settings.ts` plus `data-theme="white"` on `<html>` in `index.html` so the first paint is correct before settings load). Tailwind `@theme` block is the unresolved-token fallback only. Each `[data-theme]` selector overrides the full token set.

## ai.generateObject must use Anthropic's json-tool path, not native structured outputs

`@ai-sdk/anthropic` (v3+) auto-enables the `structured-outputs-2025-11-13` beta for any model that advertises support (Sonnet 4.6, Haiku 4.5, Opus 4.x, …). That makes Anthropic compile the JSON schema into a constrained-decoding **grammar** server-side. Non-trivial schemas — nested arrays of objects, the kind any real package job produces — exceed the compiler's time budget and fail the entire call with `Grammar compilation timed out.` after ~140s. This is what made the slides deck planner hang then die. `generateObjectWithAi` (`src/main/ai/ai.ts`) forces `providerOptions.anthropic.structuredOutputMode = 'jsonTool'` (via `objectGenerationProviderOptions`), which sends the schema as one forced tool call: no grammar, ~5s, still SDK-validated. Do not remove this; do not switch object generation back to `auto`/`outputFormat`.

## AI key status must be shared, never cached per-surface

The main process re-resolves provider keys on every request (`resolveKey` reads `~/.mim/keys.env` fresh, falling back to `process.env`), so a key change is live in main immediately. The file wins over the environment on purpose: Settings must stay authoritative, otherwise a key exported in the shell that launched the app silently shadows every set/replace/remove made in the app. The renderer is what goes stale: AI surfaces read provider-configured booleans, and if each component fetches `ai.keyStatus` once on mount and caches it locally, adding a key in Settings won't reach chat/inline until an app restart. Read key status only from the shared settings store (`keyStatuses`/`providerConfigured`/`anyKeyConfigured`); never re-introduce a per-component copy. `ai.setKey`/`ai.clearKey` emit `ai:keys-changed` (sent to the renderer and broadcast to package iframes); `App.vue` re-fetches the store on that event, and long-lived closures (e.g. the chat engine's `prepareSendMessagesRequest`) must read the store ref live rather than snapshot it.

## Team checkout mount is the sole external workspace symlink

The connected checkout lives at `~/.mim/team` and is mounted at
`<project>/.mim/team`. `syncTeamFilesMount` only creates, retargets, or removes
that symlink/junction; a real file or directory at the mount location is a
conflict and is never replaced or deleted. The filesystem symlink guard exempts
only `.mim/team/`, while the permission gate protects the mount itself.

Normal Project traversal skips `.mim`, so the Files surface, file index, and
content search explicitly traverse only `.mim/team/files`. Do not add another
external-root exception or expose the rest of the Team checkout as Files rows.

## Enabled headless apps do not get sidebar launchers

`enabled` means the app can contribute its backend jobs/tools/skills for this
user. The Navigator only renders launchers for enabled available apps that
expose a view. A package with `mim.views: []` can be correctly enabled and
still have no sidebar entry; adding a view to its Mim, Team, or Project source
makes the launcher appear after the loader rescans that origin.

## Package UI iframes can only load files under ui/

`resolvePackageUiPath` (`src/main/server/server.ts`) serves package view files relative to the view's own directory and rejects any `..` escape. A package UI script therefore **cannot** `import '../shared/foo.mjs'` — shared package modules are reachable from the backend (plain ESM relative imports work there, the runtime loads `backend/index.mjs` via a `file://` URL) but not from view iframes. If UI and backend need the same logic, the UI keeps its own copy with a comment pointing at the shared module (for example, a Team-owned Slides app keeps view-safe model logic inside its own `ui/` directory).

## GUI Electron gets the launchd PATH on macOS; Windows uses where.exe

A GUI-launched Electron app inherits launchd's PATH, which lacks
`/opt/homebrew/bin` and every shell-profile addition — so `command -v claude`
against `process.env.PATH` misses most CLI agent installs. Agent detection
(`src/main/agents/agentCatalog.ts`) therefore resolves POSIX binaries through
the user's shell (`$SHELL -lic 'command -v <bin>'`, or `/bin/sh -lc` when the
fallback shell is plain sh), takes the last non-empty stdout line (login shells
echo profile noise first), requires an absolute path, and caches the result for
the app lifetime — shell startup is expensive.

Windows has no login-shell contract and npm/pnpm tools usually expose `.cmd`
shims. Detection uses `where.exe <bin>` and accepts Windows absolute paths.
PTY spawning wraps `.cmd`/`.bat` through `cmd.exe /d /s /c`; do not bypass the
cached `binPath` by spawning a bare binary name. `resetAgentDetection()` clears
the cache (tests, future refresh).

## Linux window chrome and packaging

`titleBarStyle: 'hiddenInset'` and `trafficLightPosition` are macOS-only. Keep
them behind `mainWindowChromeOptions('darwin')`; on Linux/Windows the default
native frame is required for normal close/minimize/maximize controls.

Linux startup appends Electron's Ozone auto-detection flags in `configureLinuxCommandLine()` so Wayland desktops can choose the right backend. The release builds AppImage, deb, and tar.gz: AppImage may still need distro fuse support, while deb and tar.gz are the fuse-free alternatives.

## macOS main-window close is not app quit

The main window's red close button is a hide action on macOS. It must preserve
the existing `BrowserWindow` so Dock activation can show and focus that same
window without rebuilding renderer state or interrupting background work.
Explicit Quit sets the main-process quitting state before windows close, so it
still reaches the aggregate dirty-tab/run/agent guard and then closes pop-outs.
Windows and Linux keep close-to-quit behavior.

Quit cleanup belongs on Electron's `will-quit`, not `before-quit`: the quit
guard can cancel `before-quit`, and stopping services there would leave a still
running Mim process with its timers, watchers, telemetry, or search database
already shut down.

`will-quit` must actively close the desktop HTTP/WebSocket server, Slack Socket
Mode connection, live agent PTYs, and app jobs. Electron closing its windows
does not reliably release those Node and child-process handles by itself.

The MCP discovery file is process-owned. Publish it as soon as the desktop
server is listening, before slower background services start. Quit may remove
the file only when its port and token still match the record that process
wrote; otherwise an older, slow-shutting-down process can break MCP for a newer
running Mim instance.

## DOCX worker resources use electron-builder OS names

The .NET DOCX worker build writes `resources/docx-worker/<os>-<arch>/` using electron-builder OS names (`mac`, `win`, `linux`), not Node's `process.platform` names (`darwin`, `win32`, `linux`). The runtime resolver still checks legacy local layouts, but packaged builds and CI verification use the electron-builder names. Keep `electron-builder.config.mjs`, `scripts/build-docx-worker.mjs`, `scripts/verify-docx-worker-resource.mjs`, and `src/main/docx/worker.ts` in sync.

## Ptys die with the app: 'running' agent records reconcile to 'stopped'

node-pty processes are children of the Electron main process; they do not
survive quit or crash. An agent session record left at `status: 'running'`
on disk is therefore a lie at the next boot. `reconcileStaleSessions()`
(`src/main/agents/agentSessions.ts`, called at boot in `index.ts`) marks every
`running` record without a live pty as `stopped` and stamps `endedAt`.
Mirrors the app-job boot reconciliation; legacy `interrupted` records remain
readable and render as stopped.

## Agent session delete events must prune, not upsert

`agent.sessions.delete` removes the `.mim/agent-sessions/<id>.json` record and
its `.scrollback` file, then emits `agent:session-event` with
`type: 'session.deleted'`. Renderer consumers must remove that session id from
their aggregate stores. If delete is modeled as a normal `session.changed`
upsert, the UI re-adds a record that no longer exists on disk; reopening it then
fails with `Agent session not found` while the Activity/History row appears
stuck.

## Agent scrollback is byte-capped; xterm replay tolerates the cut

Agent session scrollback is a raw append file capped at 2 MiB: when exceeded
it is rewritten keeping only the most recent 1 MiB (front truncation at an
arbitrary byte offset, no line or escape-sequence alignment). This coarse cut
is deliberate — xterm replay resynchronises on the next escape sequence, so a
mangled first line is the worst case. Do not "improve" the truncation with
sequence-aware parsing; it buys nothing visible.

## Codex composer examples are not submitted prompts

Codex renders its rotating composer examples after the same `›` marker used
for submitted prompts. Raw PTY scrollback therefore contains plausible task
text such as `Find and fix a bug in @filename` before the user's actual input.
`extractCodexPrompt` must reject Codex's built-in examples before accepting a
title candidate. Keep the production list and the regression fixture in
`agentSessions.test.ts` aligned when Codex changes those examples; accepting
the first syntactically clean `›` segment silently assigns the example as the
Activity row title and prevents the one-shot auto-title from correcting it.
Codex also emits working spinner titles during MCP startup, before any prompt
exists. A Codex auto-title attempt with no extractable non-placeholder prompt
must return without using the task-label LLM or accepting the window title.
The false return keeps the attempt retryable when a later spinner follows the
real prompt.

## OSC-terminator BEL is not a needs-input bell

The status tracker (`src/main/agents/agentStatus.ts`) maps BEL (`\x07`) to
`needs-input` — but BEL is also a legal OSC terminator (`ESC ] 0 ; title BEL`
is how most shells set the window title). A naive scan would flag every title
update as needs-input. The tracker is a real escape-sequence state machine:
BEL inside an OSC (or DCS/PM/APC/SOS string) terminates the sequence and is
not a signal, and parser state carries across pty chunk boundaries so a
sequence split mid-chunk still parses. Keep any new output-signal logic
inside that state machine, not as a substring scan.

Codex permission overlays are signalled in those parsed titles, not by a bare
bell: `[ ! ] Action Required` alternates with `[ . ] Action Required`. Match
the complete leading status segment, keep `needs-input` blocking across both
frames, and release it only when Codex publishes a working or ordinary title.
Treating every spinner stop as blocking would make normal task completion look
permanently stuck on Input.

## Nested dialogs must use :open, not v-if

Headless UI v1's Dialog stack counter does not properly decrement when a nested Dialog is unmounted via `v-if`. After the child unmounts, the parent dialog's Escape and click-outside-to-close permanently break. Always keep nested MimDialog/PermissionConfirmDialog instances mounted and control visibility via the `:open` prop. Guard prop accesses with optional chaining when the backing data is null.

## History baselines are for authored text, not workspace mirroring

Automatic file-history baselines protect the pre-overwrite state of authored
text that an external editor may change while Mim is not watching it. Keep that
coverage narrow and bounded. Bulk data, JSON streams, PDFs, Office files, and
other binary artifacts are captured only immediately before a Mim-mediated
destructive mutation. Adding them to the baseline set or treating external adds
as recovery points turns `.mim/history` into a duplicate dataset store.

## Trace payload budgets must preserve recent file-mutation params

`TraceOutcomeTracker` lazily rebuilds write correlations after restart from the
raw params attached to `fs.write`, `fs.edit`, and `fs.create` calls. Those
payloads are functional recovery state, not optional diagnostics. Content
capture can skip read results and the payload budget can evict older diagnostic
objects, but it must not evict mutation params inside the payload-retention
window. The content budget is intentionally soft when protected params alone
exceed it. The explicit Local audit trail off state is the exception: it
deletes the whole local trace object store and suppresses future payload writes,
because a user requesting no local audit takes precedence over reconstruction.

## Zero trace retention means no local audit, not unlimited retention

`traceRetentionDays: 0` is the Workspace Local audit trail off state. It must
purge existing local trace day files and payload objects, suppress new local
writes, and continue delivering stamped events to separately controlled extra
sinks such as anonymous telemetry. Never reinterpret zero as “keep forever.”

## Nothing synchronous on main that scales with workspace or history size

Never add synchronous I/O to the main process that grows with the number of workspace files, sessions, or history entries. Use `fs/promises` or `child_process` async variants for anything that walks directories or reads multiple files. Synchronous reads that block the event loop freeze the entire app — streaming, IPC, window rendering, everything. The FTS reindex, file content search, and git-log author lookup were all converted from sync to async for this reason. New features that touch workspace-sized data must be async from the start.

## resources/ ships inside asar — spawned processes cannot read it

Electron packages `resources/` inside `app.asar`. External processes (Rscript, quarto) cannot read files from inside the archive. Anything spawned as a child process must be listed in `electron-builder.config.mjs` `asarUnpack` and the resolved path must map `app.asar` to `app.asar.unpacked` at runtime. `resources/r/**` is asarUnpack'd for the plot-capture harness (`mim-run.R`).

`resources/pi/**` follows the same rule: the external Pi process loads
`mim-extension.mjs`, resolved through `agentResources.ts`. Leaving it only in
`files` works in development but silently removes Mim tools from packaged Pi
sessions, because Pi cannot traverse Electron's virtual archive.

## Knitr fence info strings need normalization before language matching

`@codemirror/language-data` expects plain language names (`r`, `python`). Knitr/Quarto fence info strings like `{r, echo=FALSE}` must be normalized: strip surrounding `{}`, split on whitespace or comma, take the first token. Language names from `@codemirror/language-data` are case-insensitive but conventionally lowercase. The `resolveFenceLanguage` function in `codemirror/language.js` handles this normalization.

## POSIX timeout kill must signal the process group

When killing a timed-out child process on POSIX, signal the process group (`process.kill(-pid, signal)`) not just the pid. R and quarto spawn their own child processes; killing only the parent leaves orphans consuming resources. `code.run` spawns with `detached: true` and kills via `-pid`. Windows uses `taskkill /pid <pid> /T /F` (the `/T` flag kills the tree).

## SVG is intentionally NOT in the shared attachment MEDIA_TYPE_MAP

`src/renderer/services/attachments.js` defines `MEDIA_TYPE_MAP` for model-facing attachments. SVG is deliberately excluded: model providers reject SVG as an image attachment type. The in-app image viewer handles SVG fine (it renders in `<img>` tags), and `fs.readImageDataUrl` special-cases `.svg` by returning `image/svg+xml` as the media type for local preview. Do not add SVG to the attachment map.

## Broadcast vs. targeted IPC channels

`broadcastToRenderers` in `src/main/index.ts` fans an event to ALL renderer windows (main + pop-outs). Only workspace-global state channels belong there:

- `workspace:files-changed` -- every editor window must see file mutations.
- `workspace:changed` -- identity change affects all windows equally.
- `apps:changed` -- apps are workspace-scoped; every window refreshes.
- `ai:keys-changed` -- provider key availability is window-independent.
- `settings:changed` -- theme and preferences apply everywhere.

Every other channel stays on `sendToRenderer` (main-window-only):

- `gate:request` -- approval cards live only in the main window's chat. Broadcasting would enqueue duplicates and risk double-handled approvals.
- `packages:changed`, `team:changed` -- only the main window's Navigator reacts; pop-outs have no Navigator or Team UI.
- Package job events, agent session events, subagent events, auto-updater -- main window surfaces only.
- `bridge:*` commands -- always target one specific window (the main window).
- `menu:*` commands -- Phase 2 will add focused-window routing; until then they target main.

When adding a new IPC event, default to `sendToRenderer` (main-only). Promote to `broadcastToRenderers` only when pop-out windows genuinely consume the event, and verify no handler on the receiving side has side effects that break when invoked twice.

## A subagent wait timeout is not a worker timeout

`subagent.wait` is an event-driven long-poll whose timeout only returns control
to the caller. It must never abort, interrupt, or stop the child: repository
surveys and implementation turns can legitimately run for minutes or hours.
When a subagent waits for one of its own descendants, the manager releases its
execution-pool lease for the duration of that wait and reacquires it before the
parent resumes. Removing that lease handoff can deadlock a saturated pool with
every running parent waiting on children that cannot start.

## Agent tool allowlists use canonical dotted ids, not AI SDK keys

The `tools` array in an agent descriptor uses canonical registry tool ids
(dotted names like `fs.read`, `search.files`), not the AI SDK keys the model
sees (underscored: `fs_read`, `search_files`). The registry resolves them.
Core tools that have explicit AI key aliases are the exception: `shell.run` is
exposed to the model as `bash` and is allowlisted as `shell.run`. Unknown ids
are load-time diagnostics, not silent no-ops.

## App iframes must never be detached from the DOM while alive

Re-inserting an `<iframe>` into the DOM resets its browsing context: the app inside reboots from scratch (module graph, WebSocket identify, data load — around a second of blank frame). Vue's `KeepAlive` detaches the subtree on deactivate, so it does NOT preserve iframes. `WorkHost` therefore keeps every visited `PackageFrame` mounted and hides inactive ones with `v-show`; frames are only remounted when the `packages` list identity changes (install/reload/workspace switch), which is what lets `app.reload` deliver fresh app code. Keep any new iframe-hosting surface on the same pattern.

## Package tool result capping is actor-conditional, not universal

`capPackageResult` in `packageRuntime.ts` truncates a tool's result at 24,000 characters, but `executeTool` only applies it when `ctx.actor === 'ai'`. App iframes (`actor: 'package'`), MCP clients, and the CLI (`actor: 'user'`) receive results uncapped, since they consume structured JSON and a silent `{truncated, content}` wrapper reads to them as "no data" rather than an error. Widening the cap back to all actors — e.g. "simplifying" the condition away — will reintroduce apps like Knowledge silently rendering empty states once a workspace's content grows past 24k serialized characters. Note `mim tool` on the CLI intentionally calls through with `actor: 'ai'` (cli.ts), so it stays capped by design — that's not a bug.

## Renderer dev-server port is pinned because localStorage is origin-keyed

`electron.vite.config.mjs` pins the renderer dev server to `port: 5174` with `strictPort: true`. Renderer `localStorage` (recent workspaces, etc.) is scoped to the page origin, and in dev the origin is `http://localhost:<vite-port>`. Without a fixed port, electron-vite falls back to the next free port whenever something else holds 5173, silently landing the app on a fresh empty origin — recent workspaces (and anything else in localStorage) appear to vanish, even though the old origin's data is still on disk in the Electron `Local Storage/leveldb` files. Packaged builds load via `file://` and are unaffected. If this port ever needs to change, expect a one-time "recents reset" for anyone with existing dev-mode localStorage state.

## Cmd+W routing must not trust DOM focus alone

`menu:close-tab` (Cmd/Ctrl+W is a native menu accelerator; the renderer never
sees the keydown) routes by focus first, Work host second. DOM focus is a lying
signal on its own: it lingers in the Artifact pane after the last document tab
closes, and a railed pane's editor can keep `document.activeElement`
indefinitely. `closeTabActions.ts` therefore lets editor focus claim Cmd+W only
while the Artifact pane is visible AND has an active tab
(`hasActiveArtifactTab`); otherwise the close falls through to the visible Work
surface. Dropping either guard resurfaces the silent no-op where Cmd+W on an
agent session (observed with a crashed, `status: 'error'` CLI session) does
nothing — no archive, no navigation — because the close was routed to an empty
editor.
