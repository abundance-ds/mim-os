---
id: app-system-api
title: app system and API
order: 2
sources:
  - docs/app-system-api.md
  - docs/package-runtime.md
verified: bf1358ebd68b1348a9fd85c6576c5b71e5f11880
---

# app system and API

An app is a file-native capability bundle. It can contribute views (iframe UI), a terminal UI, backend jobs, AI tools, skills, and scoped data storage. UI is optional; headless apps are first-class.

## Manifest

Apps use a standard `package.json` with a `mim` block. Required fields: `manifestVersion` (must be `1`), `id` (lowercase, hyphens, underscores, max 60 chars), and `name`. Optional fields include `description`, `icon` (text token or image asset path under `ui/`), `views` (array with `id`, `label`, `src`, and `role` of `work`, `artifact`, or `either`), `tui` (`entry` pointing to an ESM module under `tui/`), `backend` (relative path to ESM module), `permissions`, `provides.tools` (named-tool grants), `dataFolder` (workspace-relative folder name), and `engines.mim` (current value: `runtime-v1`). Unknown keys inside `mim` are reported as warnings unless prefixed with `x-`. A root `README.md` is auto-discovered and surfaced as documentation.

## Terminal UI

A terminal module exports `run(context)`. The context supplies the shared
terminal toolkit, the active terminal, app metadata, and an app-attributed
`call(name, params)` function. Launch an enabled app with `mim tui <app>`;
`mim k` is the Knowledge shortcut. Terminal and iframe interfaces can coexist
over the same backend, tools, and Project data.

## Permissions

Permissions are declared in the manifest and checked at call time:

- `workspace.read` / `workspace.write` -- required for app file access.
- `ai` -- required for `ctx.ai` helpers.
- `http` -- host allowlist for `ctx.http`. Exact host, `*.` subdomain wildcard, or `*`. HTTPS only.
- `secrets` -- names the keychain secrets reachable through `ctx.secrets`.

Enabling the app is the user's consent. There is no per-call approval prompt for apps. Every HTTP request is audited as method, host, path, and status; headers, bodies, and query strings are never logged.

Apps cannot call app-management tools, trust tools, terminal tools, account tools, or session storage tools. All app tool calls still pass through the normal approval gate.

## Backend module

Backend modules are ESM files exporting plain descriptor objects. No helper library is required.

```js
export const jobs = { /* ... */ }
export const tools = { /* ... */ }
```

## Jobs

Jobs are cancellable units of backend work. Each job descriptor declares an optional `label`, `inputSchema` (JSON Schema), `concurrency` (`single` or `parallel`), `ephemeral` flag, and a required `run(ctx, input)` function. Run records persist under `.mim/packages/{packageId}/runs/`. Ephemeral jobs skip the record and never appear in history.

## AI tools

App tools become available to chat when the app is enabled. Each tool descriptor requires `description` and `execute(ctx, input)`. The runtime validates input against the declared schema. Public chat tool names are collision-safe: `pkg_<8-char hash>__<toolId>`. Tool results are capped at 24,000 characters.

## Named tools

An app can register tools under stable dotted names (e.g. `issues.list`) instead of the hash-mangled form. Two declarations are required: the manifest grants name patterns in `provides.tools`, and the backend tool opts in with a matching `name` field. Named tools are callable by AI, app UIs, other apps, and the CLI exactly like core tools. Categories `system`, `settings`, and `secrets` are core-only. Destructive final segments (`delete`, `remove`, `purge`, `destroy`, `uninstall`, `reset`) enforce a risk floor of `high`.

## Runtime context

Jobs and tools receive an app-scoped `ctx`:

::: rows
- `ctx.package` -- `{ id, name, version, source }`, injected from the enabled app.
- `ctx.data` -- app-scoped JSON KV (`ctx.data.kv`) and collections (`ctx.data.collection(name)`). Storage lives under `.mim/packages/{packageId}/data/`.
- `ctx.files` -- `readPackageText(path)` for app resources, `readWorkspaceText(path)` for workspace files (requires `workspace.read`).
- `ctx.http` -- outbound HTTPS against the manifest host allowlist. Abort signal attached automatically.
- `ctx.secrets` -- OS keychain get/set/delete/has for manifest-declared secret names. Service `Mim`, account `package:{packageId}:{name}`.
- `ctx.ai` -- `generateObject`, `callAnthropic`, `callGemini` through the main-process key resolver. Requires manifest `"ai": true`.
- `ctx.documents` -- DOCX extract/read/annotate and PDF extract helpers routed through main-process tools.
- `ctx.tools` -- calls core tools with app actor and app id. The permission gate decides whether each call is allowed.
- `ctx.progress` -- `step`, `log`, `progress`, `done` emitting normalized job events.
- `ctx.abort` -- `AbortSignal` plus `throwIfAborted()`.
:::

## Browser SDK

App UIs import the SDK from the server:

```js
import { runtime } from '/sdk/mim.js'
await runtime.ready
```

The SDK provides `runtime.jobs` (start, cancel, get, list, on), `runtime.data` (kv and collections), `runtime.tools.list()`, `runtime.secrets` (set, delete, status -- values never returned to the iframe), `runtime.workbench` (openWork, openRun, openArtifact), `runtime.ai` (registry, keyStatus), and `runtime.call()` as a low-level escape hatch. Theme tokens sync automatically via `postMessage`; for first-frame correctness, read the `#mim-theme=` URL fragment at load time.

## Agent context

A backend may export an `agentContext` function. When the app is enabled, its return value renders as a section of `.mim/agent-context.md`. Title budget: 80 chars. Body budget: 1,500 chars. At most 8 sections across all apps, 3-second total timeout.

## App locations

The loader scans three flat roots: packaged Mim `resources/apps/<id>/`, the
connected Team's `apps/<id>/`, and the current Project's
`packages/<id>/`. Project overrides Team, and Team overrides Mim, for the same
id. Activation and permission acknowledgement remain local under
`.mim/packages/enabled.json`.

## Full contract

The complete backend API, SDK reference, activation model, trust boundary,
origin workflow, and diagnostics are documented in `docs/app-system-api.md`
and `docs/package-runtime.md` in the repository. Each optional Team documents
the apps it owns.
