---
id: cli
title: command line
order: 5
sources:
  - docs/cli.md
  - src/main/cli.ts
verified: bf1358ebd68b1348a9fd85c6576c5b71e5f11880
---

# command line

The `mim` CLI is the headless interface over the same tool registry used by the desktop app. It boots `src/main/headless.ts`, registers non-UI tools, opens a workspace, and runs tool calls through the headless permission gate. It does not start Electron, the package iframe server, PTY tabs, or renderer bridge tools.

## Running

Build first, then run:

```bash
npm run build
node bin/mim.mjs help
```

When installed through npm, the binary name is `mim`.

## Workspace resolution

Commands resolve the workspace in this order:

1. `--workspace path` (or `-w path`).
2. Nearest parent directory containing `mim.yaml`.
3. Current working directory.

## Commands

```text
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

`mim init` initializes a workspace at the target path, creating the contract files (`mim.yaml`, `AGENTS.md`, `CLAUDE.md`) and the `.mim/` directory. Uses `--name` when provided, otherwise the directory basename.

`mim status` returns workspace classification and info.

`mim orient` regenerates `.mim/agent-context.md` and prints it. With `--json`, returns the structured result.

`mim log` appends a message to the human logbook at `.mim/log.md`. With `--read`, prints the logbook content.

`mim list-tools` lists all registered headless tools with name, description, and input schema.

`mim tool` is the generic tool entrypoint. It accepts one JSON object argument inline or from standard input with `--stdin`:

```bash
mim tool workspace.info '{}' --json
printf '{}' | mim tool workspace.info --stdin --json
```

Tool calls run as the `ai` actor. Approval-required calls are denied by default in non-interactive mode. On an interactive TTY, the CLI prompts on stderr. `--yes` auto-approves the headless gate for trusted local automation.

`mim go` refreshes agent context, then runs an external command in the workspace. With no command after `--`, it runs `claude`.

`mim tui <app>` launches an enabled app-owned terminal interface in the
resolved workspace. It requires an interactive terminal and uses the app's
normal identity, permissions, data, and tools. `mim k` launches Knowledge.

`mim always-on` keeps the headless kernel alive to synchronize Project and
Team changes, run scheduled/file/webhook/Slack routines, and expose signed
webhooks. It remains an ordinary local client with machine-local credentials,
activation, and scheduler state.

`mim mcp` starts the MCP stdio bridge to the running desktop app. It does not boot a headless workspace. See [MCP bridge](mcp).

## Apps and local activation

The headless kernel discovers the same direct Mim, Team, and Project app
origins as the desktop:

```bash
mim tool package.list '{}' --json
mim tool app.status '{}' --json
mim tool app.enable '{"id":"github-monitor"}' --yes
mim tool app.disable '{"id":"github-monitor"}' --yes
```

Activation is private to this person and local Project checkout. Team and
Project apps that declare effective access require permission review in the
desktop; `app.trust` is user-only and unavailable through `mim tool`.

## Trace tools

The CLI can inspect the local trace stream:

```bash
mim tool trace.stats '{"days":7}' --json
mim tool trace.query '{"days":1,"status":"error","limit":20}' --json
```
