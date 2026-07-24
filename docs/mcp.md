# MCP Server

Mim exposes `mim mcp`, a local stdio bridge to the running desktop app.

The local desktop bridge starts through:

```bash
mim mcp
```

It is a protocol bridge to the running desktop app. It does not boot the
headless kernel and does not open a workspace by itself. The desktop owns the
workspace, renderer bridge tools, approval gate, trace logging, local history,
and export renderer.

## Connection Model

```
Claude Code / Codex / Gemini CLI
    stdio JSON-RPC 2.0
mim mcp
    WebSocket JSON-RPC
Mim Desktop
    Tool registry
```

Pi uses the same authenticated desktop tool surface through Mim's bundled Pi
extension, without starting an MCP server:

```
Pi 0.76+
    bundled Mim extension (WebSocket JSON-RPC)
Mim Desktop
    Tool registry
```

On desktop start, Mim writes `~/.mim/server.json`:

```json
{ "port": 54321, "token": "uuid" }
```

The file is auth material. It is written atomically with owner-only permissions
where the filesystem supports chmod. On app quit, Mim deletes it best-effort.
That discovery token is valid for the desktop process lifetime. The file is
published immediately after the loopback server starts, before routine and
integration background services initialize. Cleanup is ownership-checked: an
older desktop process finishing a slow quit cannot delete a newer process's
discovery record.

Agent sessions launched from Settings > Apps & agents receive per-session `MIM_PORT`
and `MIM_TOKEN` environment variables. Running `mim mcp` outside Mim falls back
to `~/.mim/server.json`. Pi's bundled extension consumes the per-session values
directly. Per-agent tokens are revoked when the live agent session exits, is
killed, or fails during launch after token creation.

## Security Boundary

MCP clients identify to the desktop WebSocket with `{ "type": "mcp", "token":
"..." }`. The desktop binds the connection as `actor: "user"` with the MCP
session id.

The curated tool surface is enforced in `src/main/server/server.ts` before
`tools.call()`. Settings > Tools filters both `__meta.tools` and direct MCP
execution, so a cached/raw client cannot call a disabled tool. The stdio bridge
also maps only curated MCP names, but that is not the security boundary because
local processes can speak WebSocket directly if they have the bearer token.

The bundled Pi extension authenticates as the same local `user` actor and uses
the same curated metadata and execution checks. It calls `__meta.client` with
`pi`, so traces and comment authorship distinguish Pi from other CLI clients.
The internal WebSocket identity reuses the MCP-authenticated allowlist; the Pi
integration itself is a direct extension adapter, not an MCP transport.

`packages.list` stays package-only. `__meta.tools` is MCP-only and requires
successful MCP identification.

The MCP stdio bridge returns Mim's supported MCP protocol version during
`initialize`; it does not echo future client versions. Desktop WebSocket calls
are bounded by a per-call timeout so a hung desktop request fails the MCP call
instead of blocking stdin processing forever.

## Tool Surface

MCP tool names avoid dots. The desktop returns metadata from `__meta.tools`; the
stdio bridge exposes those names to MCP clients and forwards calls to the Mim
tool names.

### Static Tools

Present in the MCP catalog when the underlying Mim tool is registered and
enabled in Settings > Tools:

| MCP Tool | Mim Tool |
|---|---|
| `editor_open` | `editor.open` |
| `editor_state` | `editor.state` |
| `chat_send` | `chat.send` |
| `subagent_spawn` | `subagent.spawn` |
| `subagent_wait` | `subagent.wait` |
| `subagent_send` | `subagent.send` |
| `subagent_interrupt` | `subagent.interrupt` |
| `subagent_stop` | `subagent.stop` |
| `subagent_status` | `subagent.status` |
| `subagent_list` | `subagent.list` |
| `subagent_result` | `subagent.result` |
| `comments_list` | `comments.list` |
| `comments_add` | `comments.add` |
| `comments_reply` | `comments.reply` |
| `comments_resolve` | `comments.resolve` |
| `history_list` | `history.list` |
| `history_restore` | `history.restore` |
| `search_sessions` | `search.sessions` |
| `pdf_extract` | `documents.pdf.extract` |
| `export_docx` | `export.docx` |
| `export_pdf` | `export.pdf` |
| `workspace_orient` | `workspace.orient` |
| `fs_read` | `fs.read` |
| `search_files` | `search.files` |
| `skill_list` | `skill.list` |
| `skill_get` | `skill.get` |
| `log_append` | `log.append` |
| `workspace_info` | `workspace.info` |
| `system_prompt` | `system.prompt` |
| `web_read` | `web.read` |
| `web_search` | `web.search` |
| `browser_open` | `web.live.open` |
| `browser_act` | `web.live.act` |
| `settings_get` | `settings.get` |
| `settings_set` | `settings.set` |
| `slack_status` | `slack.status` |
| `slack_connect` | `slack.connect` |
| `slack_disconnect` | `slack.disconnect` |
| `slack_bot_status` | `slack.bot.status` |
| `slack_bot_connect` | `slack.bot.connect` |
| `slack_bot_disconnect` | `slack.bot.disconnect` |
| `slack_bot_setup` | `slack.bot.setup` |
| `slack_bot_check` | `slack.bot.check` |
| `slack_listener_status` | `slack.listener.status` |
| `google_status` | `google.status` |
| `google_set_oauth_client` | `google.setOAuthClient` |
| `google_connect` | `google.connect` |
| `google_disconnect` | `google.disconnect` |

`log_append` is the MCP logbook surface; MCP does not expose `log.read`. The `system_prompt` tool resolves `{{PROJECT_LOG}}` for clients that request the full prompt.

`editor_state` reports what the user has open in the desktop editor: open tabs
and the active document, with workspace-relative paths and unsaved (dirty)
flags. The renderer pushes tab snapshots to the main process whenever they
change; the tool serves the cached snapshot and returns `available: false` when
no editor is reporting. A dirty tab means the file on disk may be behind the
buffer the user sees.

Connection management tools (`slack_connect`, `slack_bot_connect`,
`google_connect`, etc.) and `settings_get`/`settings_set` are part of the
curated MCP surface so CLI agents can set up integrations. `settings_set`
cannot write `tools`, `tools.enabled`, or `tools.disabled`; tool availability is
user-controlled through Settings > Tools.

The live browser tools use the desktop Electron runtime. `browser_open` creates
or reuses the MCP session's live browser context, and `browser_act` observes,
clicks, types, scrolls, waits, extracts, shows, hides, or closes that same
session. Local desktop MCP clients may open public websites and loopback
development servers on `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`.
Public-page sessions cannot reach loopback subresources. The **Use live browser** row in
Settings > Tools is enabled by default and controls whether both tools appear in
the MCP catalog.

### Conditional Integration Data Tools

Slack and Google data tools appear in the MCP catalog only when the corresponding
token is configured in the OS keychain and the corresponding row is enabled in
Settings > Tools. Desktop MCP calls use the `user` actor. The MCP allowlist plus
tool policy is the desktop security boundary, and CLI agents have their own
permission gates.

**Slack** (when token is configured):

| MCP Tool | Mim Tool |
|---|---|
| `slack_channels` | `slack.channels` |
| `slack_users` | `slack.users` |
| `slack_dms` | `slack.dms` |
| `slack_history` | `slack.history` |
| `slack_replies` | `slack.replies` |
| `slack_search` | `slack.search` |
| `slack_send` | `slack.send` |

**Google** (when OAuth token is configured):

| MCP Tool | Mim Tool |
|---|---|
| `gmail_search` | `gmail.search` |
| `gmail_read` | `gmail.read` |
| `gmail_send` | `gmail.send` |
| `calendar_events` | `calendar.events` |
| `calendar_create` | `calendar.create` |
| `drive_search` | `drive.search` |
| `drive_meta` | `drive.meta` |
| `docs_read` | `docs.read` |
| `sheets_meta` | `sheets.meta` |
| `sheets_read` | `sheets.read` |
| `sheets_write` | `sheets.write` |
| `sheets_append` | `sheets.append` |

### Dynamic App Tools

Each exposed Mim tool must have an `inputSchema`. Registered core MCP tools
without schemas fail MCP metadata generation loudly; static specs whose Mim tool
is absent in the current kernel are omitted, which lets headless kernels expose
only the tools they actually registered. Named tools from enabled apps are
exposed dynamically alongside the core set — the server queries the active named
tool registrations at request time. Named tools without an `inputSchema` are
silently excluded from the MCP catalog.

## Client Config

Settings > Apps & agents shows a **Connect** button next to each installed CLI agent
that supports Mim's MCP bridge. Clicking it runs the agent's native `mcp add`
command behind the scenes:

| Agent | Command |
|---|---|
| Claude Code | `claude mcp add mim -- mim mcp` |
| Codex | `codex mcp add mim -- mim mcp` |
| Gemini CLI | `gemini mcp add mim mim mcp` |

Pi has no Connect/Disconnect control. Mim appends its bundled extension to each
Pi launch and resume; the extension registers the same enabled tool catalog
directly with Pi. Settings therefore reports **Mim tools built in**. If the
desktop connection drops, Pi remains usable and `/mim-reconnect` retries it.

This is a one-time setup — the config persists across sessions. The
**Disconnect** option is in the agent's Customise section.

After connection, ask the CLI agent to use Mim's `browser_open` MCP tool when a
local preview is needed. This is separate from ChatGPT's built-in Browser surface,
which is not attached to CLI sessions.

Manual setup is also possible. The equivalent JSON config (for agents that
accept it):

```json
{ "mcpServers": { "mim": { "command": "mim", "args": ["mcp"] } } }
```

The `mim` binary uses built output, so run `npm run build` before local CLI
smoke tests.

## Source

- Stdio bridge: `src/main/mcp/stdio.ts`
- Discovery file helpers: `src/main/mcp/discovery.ts`
- WebSocket MCP auth and allowlist: `src/main/server/server.ts`
- CLI command: `src/main/cli.ts`
- Agent env injection: `src/main/agents/agentSessions.ts`, `src/main/pty.ts`
- Pi direct adapter: `resources/pi/mim-extension.mjs`,
  `src/main/agents/agentResources.ts`
- Tests: `src/main/mcp/stdio.test.ts`, `src/main/server/server.test.ts`,
  `src/main/agents/agentSessions.test.ts`, `src/main/cli.test.ts`
