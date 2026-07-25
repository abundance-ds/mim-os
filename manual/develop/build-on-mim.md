---
id: build-on-mim
title: build on mim
order: 1
sources:
  - README.md
  - docs/_MAP.md
verified: bf1358ebd68b1348a9fd85c6576c5b71e5f11880
---

# build on mim

Mim is a desktop runtime for bespoke agentic applications. You extend it by writing apps, skills, tools, and CLI integrations against its tool registry and permission gate. This page is the entry point; each section links to the full reference.

## Apps

An app is a file-native capability bundle: backend jobs, AI tools, data storage, and optional iframe UI, declared in a `package.json` manifest with a `mim` block. Apps run under a scoped runtime context that enforces identity, permissions, audit, and cancellation. Headless apps (no UI) are first-class. The full manifest, backend API, SDK, and runtime context are documented in [app system and API](app-system-api). Companies can maintain their own apps in an optional Team repository; Project-specific apps remain in the Project.

## Skills

A skill is a markdown instruction folder (`SKILL.md` plus optional resources) that the agent loads on demand. Skills gate tools: tools listed in `unlocks` stay hidden from chat until the skill activates. Workspace skills, personal skills, added sources, and app-bundled skills each have their own precedence layer. See [skills](skills) for the format, discovery rules, and progressive tool gating.

## Tools for CLI agents

Mim exposes its tool registry to Claude Code, Codex, and Gemini CLI through a local MCP stdio bridge. Pi gets the same curated catalog through a first-party extension that Mim loads automatically for its sessions. Both paths connect to the running desktop over an authenticated WebSocket, so CLI agents share the same workspace, approval gate, and trace log. The exposed surface includes file tools, web tools, editor state, integration data tools, and named app tools. See [MCP bridge](mcp) for the tool surface and connection architecture. The generated [tool catalog](/develop/tools) lists every registered tool with its effect classification.

## Headless CLI

The `mim` binary boots a headless tool registry without Electron. It runs Project commands, generic tool calls, trace queries, app runtime operations, app-owned terminal interfaces, and always-on routines from any shell. `mim tui <app>` launches an enabled app's TUI (`mim k` opens Knowledge), while `mim go` refreshes agent context and launches an external command (defaulting to `claude`) in the Project. See [command line](cli) for the full command set.

## Workspace contract

Every Mim Project has a `mim.yaml` config, an `AGENTS.md` system prompt, and a `.mim/` runtime directory. The config declares the Project name and optional sync mode. A connected Team contributes shared files at `.mim/team/files`. See [workspace contract](workspace-contract) for the schema and layout.

## Models

The [model catalog](/develop/models) lists every model in the registry with provider, context window, and pricing.

## Security

The permission gate runs before every tool call. It classifies effects as read, mutate, or external, and prompts the user in normal and strict modes before the agent can run a mutating or external action. Apps are checked against declared manifest permissions. See [security](security) for the gate architecture, actor modes, and path classification.
