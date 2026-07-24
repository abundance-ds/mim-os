# AI Tools

Read this before changing chat tools.

## Map

- AI-facing tools: `src/main/ai/aiRuntime.ts`
- Inline editor tools: `src/main/ai/aiRuntime.ts`
- Kernel tools: `src/main/tools/*.ts`, `src/main/sessions.ts`, `src/main/ai/ai.ts`, `src/main/pty.ts`
- Prompt tool list and template placeholders: `src/main/ai/systemPrompt.ts`
- Workspace tree prompt context: `src/main/ai/workspaceTree.ts`
- Attachment normalization: `src/main/attachments.ts`, `src/renderer/services/attachments.js`, `src/renderer/components/chat/composerLogic.ts`
- Permission policy: `src/main/security/gate.ts`

## Rules

- AI SDK `tool()` definitions use `inputSchema`, never `parameters`.
- AI-facing names use underscores: `fs_read`, `editor_open`, `package_create`.
- Kernel names use dots: `fs.read`, `editor.open`, `package.create`.
- AI SDK tools are defined in the main process and must call `tools.call(name, params, { actor: 'ai', sessionId })`.
- AI SDK tool execution is wrapped by a main-process wall-clock timeout so a hanging kernel tool cannot leave the chat stream waiting forever.
- Before validation/model conversion, chat history is repaired by removing non-terminal assistant tool-call parts. A persisted or in-memory interrupted turn must never poison future requests with a missing tool result.
- Main-process permission gate owns approval. Do not add renderer-side approval gates.
- AI-facing tools must preserve the real kernel tool semantics. A tool named `fs_create` must call `fs.create` and create the file after the permission gate allows it; do not route real actions into a separate proposal state.
- Tool descriptions are for the model. Describe constraints and non-obvious behavior only.

## Prompt Context

`AGENTS.md` template placeholders are resolved in `src/main/ai/systemPrompt.ts`. The standard template includes `{{TOOL_SET}}`, `{{SKILL_CATALOG}}`, `{{AGENT_CONTEXT}}`, `{{WORKSPACE_TREE}}`, and `{{PROJECT_LOG}}`.

`{{WORKSPACE_TREE}}` is a content-free orientation map from `src/main/ai/workspaceTree.ts`. It shows up to 50 root entries and up to 10 entries inside each visible root folder. Special/generated folders such as `.mim/`, `.git/`, `knowledge/`, `issues/`, and `node_modules/` are listed but their contents are hidden. Root symlink directories are followed for that one visible child listing only; nested folders inside them are not expanded. The tree is context, not authority: use `fs_list` or `fs_read` before relying on a file's current contents.

Attached text context is converted into model-visible `<attached-file>` blocks in `src/main/ai/aiRuntime.ts`. When the data context has a workspace-relative `path`, the block includes `path="..."`; agents should use that path with `fs_*` tools when they need to inspect or edit the source file. Direct external attachments may only have a `name`, so do not invent a workspace path for them.

## File Tools

- `fs_list` returns capped workspace entries with `path`, `name`, `type`, `size`, `modifiedAt`, `createdAt`, and optional `lastChangedBy` when `include_last_changed_by` is true; recursive mode skips heavy/generated directories.
- `fs_read` returns `{ content, path, total_lines, start_line, end_line, total_chars, hash, version, truncated }`; `hash`/`version.hash` are for the full file, even when `content` is a line window or `max_chars`-truncated.
- `fs_write` overwrites the whole file after the permission gate allows it. Prefer `fs_edit` for small changes.
- `fs_edit` changes the file after the permission gate allows it, requires exactly one match, and tolerates common LLM typography/whitespace drift.
- `fs_create` and `fs_delete` mutate the real filesystem after the permission gate allows them.
- If an action needs approval, the permission gate suspends the exact tool call before execution. The result returned to the model must describe the real executed action, not a durable proposal.
- Backend-only `fs.exists` remains for packages/internal calls; it is not exposed to chat.
- `fs.copy`, `fs.trash` (recoverable OS Trash), and `fs.import` (ingest an external absolute path) are kernel tools driven by the Files UI; they are not exposed to chat. Chat deletion stays `fs_delete` (hard delete).

## Cross-Surface Tools

- `editor_open` opens a workspace path in the Editor Artifact.
- `bash` calls `shell.run` as the AI actor. Default (captured) mode spawns the command in the workspace and returns `{ exitCode, stdout, stderr, products, runId }` — stdout/stderr are tail-truncated, and `products` lists files the run created or changed (ranked, workspace-relative paths). The exact form `Rscript <file>.R` is rewritten to run through a plot-capture harness so base-graphics plots are returned as image products. Set `terminal: true` to instead type the command into the user's visible Terminal (mounting it in the background if needed) and return immediately without capturing output — use that for things the user should watch (dev servers, watch modes) rather than one-shot commands. See docs/code-execution.md for the full contract.

## Comment Tools

Chat exposes inline review comment tools, routed by file type (`src/main/comments/dispatch.ts`): markdown files use `<comment>`/`<note>` tags, code and plain-text files use `@mim` line markers.

- `comments_list` parses a file and returns thread anchors, notes, raw offsets, and line numbers.
- `comments_add` anchors a new thread by exact `anchor_text`; it matches the human-visible stripped document first, then raw text, and refuses ambiguous or overlapping anchors.
- `comments_reply` appends a note to an existing thread.
- `comments_resolve` deletes the comment markup while keeping the anchor text. Pass `id` for one thread or `all: true` to resolve every thread in the file.

The document on disk remains raw: comment markup is visible to `fs_read`. Prefer `comments_*` tools over direct `fs_edit` changes when adding, replying to, or resolving threads. Direct file edits may change prose around comments, but should not hand-edit comment markup unless the comments tools cannot express the operation. See [comments.md](comments.md) for the full syntax and surface list.

## Integration Tools

Chat exposes selected personal integration tools through `src/main/ai/aiRuntime.ts`.

- Slack read tools: `slack_search`, `slack_history`, `slack_channels`.
- Google read tools: `gmail_search`, `gmail_read`, `calendar_events`, `drive_search`, `docs_read`, `sheets_meta`, `sheets_read`.
- Google outbound/write tools: `gmail_send`, `calendar_create`, `sheets_write`, `sheets_append`.

Slack send is a kernel/CLI tool only, not a chat tool. Google outbound/write chat tools are `external` main-process tool calls and require approval in normal and strict modes (their `high` risk only drives the approval card's caution styling).

Slack and Google tools are included only when their Settings > Tools rows are
enabled. Google also requires a connected account whose stored token grants
the relevant OAuth scopes.

Integration secrets stay in the OS keychain via `src/main/integrations/secrets.ts`. Packages cannot call personal Slack or Google tools in runtime v1.

## Web Tools

Chat exposes search plus two web access modes:

- `web_search` calls `web.search` and returns search results via the Exa API. Returns `query` and `results[]` with `title`, `url`, `snippet`. Requires `EXA_API_KEY` in `~/.mim/keys.env` (set via Settings → Models → Integrations) or the environment; the file takes priority. Category `network`, risk `medium`.
- `web_read` calls `web.read`, the simple stateless/PDF reader. It returns cleaned content from selectable PDFs or Chromium-rendered web pages with `url`, `final_url`, `title`, `content`, `content_length`, `source`, `elapsed_ms`, and chunk continuation fields when truncated. PDF routing is mechanical: `.pdf` paths or successful `HEAD` responses with a PDF content type use local `pdfjs-dist` extraction. Other pages render in a stateless hidden Chromium session and flow through the shared HTML-to-Markdown parser; pages that expose no readable Markdown fail with `No readable content captured` instead of returning an empty successful result. Passing `stateful: true` uses approved Website Access (`persist:mim-browser-session`) after a domain grant exists; agents should ask before using sign-in, consent, cookies, or other site access already set up for that website, and should not treat stateful reads as a general fix for timeouts, bot detection, extraction bugs, or account-only walls. `web_read` does not return page-status verdicts, capture diagnostics, source health, hidden fallback attempts, or cache metadata. Only public `http`/`https` URLs are allowed; private/loopback initial URLs, redirect targets, and rendered subresource requests are blocked. Category `network`, risk `medium`.
- `browser_open` and `browser_act` call `web.live.open` and `web.live.act`, the Markanywhere-port live browser. `browser_open` opens an Electron browser session hidden by default, or visible with `visible: true`, and returns one bounded observation field plus compact action refs relevant to the returned chunk. Desktop sessions accept public websites plus explicit loopback development targets (`localhost`, `*.localhost`, `127.0.0.0/8`, and `::1`); a loopback-opened session may load loopback HTTP(S) and WebSocket resources, while public-page sessions and all other web-reading paths remain unable to reach loopback or private networks. `browser_act` runs `observe`, `click`, `type`, `scroll`, `wait`, `extract`, `show`, `hide`, or `close`; click/type/scroll return a fresh bounded observation after a short bounded wait. `show` and `hide` expose or hide the exact AI-controlled session with a Mim-owned URL bar and reload control for debugging or user-assisted auth/CAPTCHA/MFA/legal-consent handoff. Refs are regenerated on every observation; old refs fail with a stale-ref error. Links use Markanywhere's `ref:<id>:<href>` destination form and controls surface short `ref` attributes in the observation. `browser_open.timeout_ms` bounds navigation, page-idle detection, and first capture; follow-up actions also bound page-side JavaScript execution. `max_chars` defaults to 100000, and `start_from_char` continues through large cleaned page text. When a chat history estimate exceeds 100000 tokens, old completed `browser_open`/`browser_act` observation results are compacted in place: the tool result remains, but stale `observation` and `refs` payloads are replaced with a content-removed note while the newest two browser observations stay intact. Use this mode for interactive sites, local development previews, lazy-loaded content, form input, buttons, and cookie banners that do not require legal/account consent.

MCP exposes the same web tools as `web_search`, `web_read`, `browser_open`, and `browser_act`; the live browser still runs in the desktop Electron runtime, including when a local CLI agent opens a loopback development server.

`web_read` has a main-process wrapper timeout of 45 seconds by default. If the caller supplies `timeout_ms`, the wrapper allows that render/fetch budget plus a small buffer, capped by the AI-runtime maximum for web reads.

Website Access setup remains kernel/UI-only. `web.browser.status` returns `{ enabled, allowedDomains, profile_available }`; `web.browser.allowDomain`, `web.browser.removeDomain`, `web.browser.open`, and `web.browser.clearProfile` maintain grants and the stored website access data. For AI chat and headless approval-mode reads or live-browser opens, an ungranted `stateful: true` domain is approved directly from the permission request and written to the allowlist before `web.read` or `web.live.open` executes.

Implementation: `src/main/web/webSearch.ts`, `src/main/web/readWebUrl.ts`, `src/main/web/readUrl.ts`, `src/main/web/readRenderedUrl.ts`, `src/main/web/readBrowserSessionUrl.ts`, `src/main/web/browserSession.ts`, `src/main/web/browserSessionSettings.ts`, `src/main/web/renderedBrowser.ts`, `src/main/web/renderedCapture.ts`, `src/main/web/liveBrowser.ts`, `src/main/web/liveBrowserCapture.ts`. Tests: `src/main/web/webSearch.test.ts`, `src/main/web/readWebUrl.test.ts`, `src/main/web/readUrl.test.ts`, `src/main/web/webReadEvaluation.test.ts`, `src/main/web/readRenderedUrl.test.ts`, `src/main/web/readBrowserSessionUrl.test.ts`, `src/main/web/browserSession.test.ts`, `src/main/web/browserSessionSettings.test.ts`, `src/main/web/renderedBrowser.test.ts`, `src/main/web/renderedCapture.test.ts`, `src/main/web/liveBrowser.test.ts`, `src/main/web/liveBrowserCapture.test.ts`, `src/main/web/liveBrowserTools.test.ts`, `src/main/tools/web.test.ts`.

## Trace Tools

Chat exposes trace analysis tools over the local audit stream:

- `trace_query` calls `trace.query` and returns capped, redacted digest events. Blob payloads are returned by `payloadRef` only, never inlined.
- `trace_stats` calls `trace.stats` and aggregates tool errors/durations, model tokens/cost, package events, gate decisions, job health, day trends, and post-AI edit outcomes.

Both tools are read-only kernel calls and inherit the active chat session trace context.

## Package Tools

Enabled package AI tools are passed into `createAiSdkTools({ packageTools })`
and exposed under the runtime-generated public name. Dispatch is conditional:
a tool registered in the ToolRegistry under its public name (named granted
tools, registered by the named-tool sync with their own per-tool gate policy)
is called directly by that name, so the gate sees the real tool id — this is
what lets a scoped package agent's delegated `toolAllowlist` (which lists
those ids) pass the gate's surface check, and applies the per-tool policy
instead of the blanket `package.tools.execute` one. Un-named chat-audience
tools have no individual registration and execute through
`package.tools.execute`. Package tools cannot shadow core AI tool names.

Package authoring tools are also exposed to chat, but the built-in `build-app`
skill gates the dev-loop surface until it activates. The AI-facing wrappers are:

- `package_create` for UI or headless package scaffolds, including backend,
  manifest permissions/provides, package skills, and README content.
- `package_validate` for direct workspace package diagnostics before relying on
  the loader.
- `package_reload` for rescan + runtime cache invalidation + named-tool sync.
- `app_status` and `app_enable` for enablement state. `app.trust` is not an AI
  tool and remains user-only.
- `package_capabilities_list`, `package_tools_execute`, and
  `package_jobs_start` for verification after reload/enable.

## Skill Gating

Tools declared in skill `unlocks:` frontmatter are removed from the visible
chat tool set until their skill activates, either by the model calling
`skill(name)` or by a composer-selected chip sent as `skills: string[]` in the
`/api/ai/chat` body. The controlled set is derived from `skill.list` per request
(`listSkillUnlocks`); a skill that unlocks a base tool name gates that tool for
every chat. `tools:` is descriptive catalog metadata. See [skills.md](skills.md).
`skill_create` and `skill_update` are additionally always hidden until an
active skill unlocks them, including when their declaring Team skill is
unavailable or disabled.

Chat also defines two narrow Personal-skill mutation wrappers:

- `skill_create` calls `skill.create` with `destination: personal` and one
  complete `SKILL.md`.
- `skill_update` calls `skill.update` with one complete replacement plus the
  current `expectedRevision`.

They are not general filesystem tools. The `mim` Team's `build-email-voice`
skill unlocks both while constructing a Personal voice skill; the generated
`email-voice` skill unlocks only `skill_update` for restrained,
evidence-based self-learning. Both kernel calls remain medium-risk writes
behind the normal permission gate.

## Backend AI And Document Tools

- `ai.generateObject` is a kernel tool for package backend jobs. It is not
  exposed as a chat tool. Packages must declare `ai: true`.
- Package backends can also use `ctx.ai.callAnthropic` for Anthropic tool loops
  and `ctx.ai.callGemini` for Gemini text calls. These route through the same
  main-process key resolver but are runtime helpers, not chat tools.
- `documents.docx.extract`, `documents.docx.read`, `documents.docx.annotate`,
  `documents.docx.comments`, `documents.docx.validate`, and
  `documents.docx.workerStatus` are kernel tools for package jobs and internal
  workflows. Chat reaches them through package tools such as DOCX Review.
- `documents.pdf.extract` is a kernel PDF text helper for package jobs and
  internal workflows. It reads workspace PDFs and returns selectable text plus
  basic metadata; package UIs should write dropped PDFs into the workspace
  first, then call this helper from backend jobs.
- `documents.importMarkdown` and `documents.importMarkdown.formats` are kernel
  tools for package jobs and internal workflows. The external Import to
  Markdown package in shoulders-ai/mim-apps exposes the user-facing app/tool
  for DOCX, XLSX/XLSM, BibTeX, and selectable-text PDF conversion.

## Tests

- `src/main/ai/aiRuntime.test.ts` protects AI-facing names, schemas, dispatch, package tools, and provider endpoint normalization.
- `src/main/server/server-ai.test.ts` protects `/api/ai/chat`, `/api/ai/inline`, and `/api/ai/ghost` endpoint wiring.
- `src/main/tools/fs.test.ts` protects filesystem behavior.
- `src/main/search/textMatch.test.ts` protects `fs_edit` matching.
