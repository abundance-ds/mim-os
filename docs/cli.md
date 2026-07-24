# Headless CLI

The `mim` CLI is the Tier 1 headless interface over the same main-process tool registry used by the app.

It boots `src/main/headless.ts`, registers safe non-UI tools, opens a Project,
and runs generic `mim tool` calls as the `ai` actor through the headless
permission gate. It does not start Electron, PTY tabs, or renderer bridge
tools. The explicit `always-on` command starts the local HTTP/webhook runtime.

## Running

Build first:

```bash
npm run build
node bin/mim.mjs help
```

When installed through npm, the binary name is `mim`.

## Workspace Resolution

Commands resolve the workspace in this order:

1. `--workspace path`
2. nearest parent containing `mim.yaml`
3. current working directory

`mim init [path]` initializes the target path, creates the workspace contract, and uses `--name` when provided. `--workspace` must be followed by a path.

## Commands

```bash
mim init [path] [--name name]
mim status [--workspace path]
mim orient [--workspace path] [--json]
mim log <message> [--workspace path]
mim log --read [--workspace path] [--json]
mim list-tools [--json]
mim tool <name> [json|--stdin] [--workspace path] [--json] [--yes]
mim go [--workspace path] [-- command ...]
mim always-on [--workspace path] [--host address] [--port number]
mim tui <app> [--workspace path]
mim k [--workspace path]
mim mcp
```

`mim orient` regenerates `.mim/agent-context.md` and prints it by default.

`mim log` appends or reads the human logbook at `.mim/log.md`.

`mim tool` is the generic tool entrypoint. It accepts one JSON object argument or reads the object from standard input:

```bash
node bin/mim.mjs tool workspace.info '{}' --json
printf '{}\n' | node bin/mim.mjs tool workspace.info --stdin --json
```

For secret-bearing calls, prefer `--stdin` from a trusted local shell so tokens do not need to be typed directly into the command line.

Approval-required `mim tool` calls are denied by default in non-interactive mode. On an interactive TTY the CLI prompts on stderr. `--yes` is the explicit escape hatch for trusted local automation and auto-approves the headless gate.

`mim go` refreshes agent context, then runs an external command in the workspace. With no command it runs `claude`.

`mim tui <app>` launches an enabled app's production terminal interface in the
resolved Project. It requires an interactive terminal and preserves the same
app identity, declared permissions, data, and named tools as the desktop view.
`mim k` is the short form for `mim tui knowledge`; the desktop Knowledge view
continues to live alongside it.

`mim always-on` keeps the same headless kernel alive for one Project. Each
one-minute heartbeat:

- fetches/synchronizes the machine's managed Project and Personal Team
  checkouts, with the same offline retry and conflict-stop behavior as desktop;
- refreshes Team and Project routine definitions and file watchers;
- refreshes Slack Socket Mode connections, whose own reconnect loop remains
  active between heartbeats;
- runs due schedules without allowing one failed routine to block the others.

Failed scheduled runs retain their overdue time and retry on the next
heartbeat. Activation, authority acknowledgements, credentials, scheduler
heartbeat, Slack ledger, and thread mappings remain local to the always-on
machine. Signed webhooks use the same `POST /api/hooks/:routine` endpoint as
desktop. The server binds to `127.0.0.1` and an available port by default;
`--host` and `--port` make deployment behind the operator's chosen network
boundary explicit. `always-on.status` reports the runtime heartbeat, endpoint,
Slack state, and latest cycle error.

`mim mcp` starts the MCP stdio bridge to the running desktop app. It does not
boot a headless workspace. It uses `MIM_PORT`/`MIM_TOKEN` when present, otherwise
reads `~/.mim/server.json`. See [mcp.md](mcp.md).

## Trace Tools

The CLI can inspect the same local trace stream used by chat observability:

```bash
# Aggregate recent tool, model, gate, job, package, day, and outcome health
node bin/mim.mjs tool trace.stats '{"days":7}' --json

# Return capped redacted digest events; payload blobs stay referenced by pointer
node bin/mim.mjs tool trace.query '{"days":1,"status":"error","limit":20}' --json

# Regenerate .mim/agent-context.md, including Observability health when signals exist
node bin/mim.mjs orient --json
```

## Apps and Local Activation

On Project open, the headless kernel discovers the same direct Mim, Team, and
Project app origins as Electron and registers the same local activation and app
runtime tools:

```bash
# List available apps and their Mim, Team, or Project origin
mim tool package.list '{}' --json

# View local activation and permission-review state
mim tool app.status '{}' --json

# Activate an available app for this local Project checkout
mim tool app.enable '{"id":"github-monitor"}' --yes

# Deactivate it locally
mim tool app.disable '{"id":"some-addon"}' --yes
```

`app.enable` and `app.disable` are settings mutations, so they require `--yes`
or TTY confirmation. `app.trust` is user-only and hard-denied to the `ai`
actor, including `mim tool`; review a Team or Project app's declared access in
the desktop UI before enabling it.

### Availability and activation

Apps have separate availability and local activation:

- **available** — an app directory in packaged Mim resources, the connected
  Team's `apps/`, or the current Project's `packages/`.
- **enabled** — a gitignored `.mim/packages/enabled.json` entry for this local
  Project checkout. It controls this person's views and capability set.

Project overrides Team and Team overrides Mim for duplicate ids. Activation is
always local. Project apps update with Project Git sync, Team apps with Team
sync, and Mim apps with application updates; there is no per-app download or
install lifecycle.

## Source

- CLI entrypoint: `src/main/cli.ts`
- App TUI host: `src/main/tui/packageTui.ts`
- Headless registry: `src/main/headless.ts`
- Always-on lifecycle: `HeadlessKernel.startAlwaysOn()` in `src/main/headless.ts`
- MCP stdio bridge: `src/main/mcp/stdio.ts`
- Binary wrapper: `bin/mim.mjs`
- Build output: `out/main/cli.js`
- Tests: `src/main/cli.test.ts`
