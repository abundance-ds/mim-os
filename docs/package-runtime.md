# App Runtime And Job SDK

Status: core subsystem implemented, including direct-origin discovery,
`ctx.http`, `ctx.secrets`, app skills, tools, agents, and jobs. Backend process
sandboxing and individual app-tool settings remain follow-up work.

This document defines the current app runtime architecture. The app system is
the reason this repo exists: Mim should be
a local-first desktop runtime for bespoke workflow software, not a fixed app
with a plugin drawer.

## Objectives

The runtime must make apps feel first-class, safe, and pleasant to build.

- Apps are file-native capability bundles discovered from Mim, Team, or
  Project origins. UI is optional.
- An app may contribute views, jobs, AI tools, filesystem skills
  (`skills/<name>/SKILL.md`, see [skills.md](skills.md)), templates, data
  collections, or any combination of those.
- Headless apps must work. Example: a `stats-checker` app can add chat
  tools without ever opening an app view.
- App backend code runs through a runtime context that enforces app
  identity, permissions, audit, output limits, cancellation, and data scoping.
- App UI uses a small SDK, not raw tool registry calls as the normal path.
- The general chat agent can use enabled app AI tools exactly like core
  tools, with clear provenance and user control.
- Job execution is visible, cancellable, recoverable, and auditable.

Design bar: the app runtime should be the best-engineered subsystem in the
repo. DX should feel boring in the best way: small concepts, normal JavaScript,
excellent errors, and no framework ceremony.

## Product Principles

- Visibility: users can see what app is running, what it is doing, and what
  tools it has made available to chat.
- Mapping: each user action maps to one clear runtime action: start job, cancel
  job, enable tool pack, activate skill.
- Constraints: dangerous actions are constrained by manifest permissions,
  runtime identity, and approval gates before damage can happen.
- Recovery: failed jobs keep a run summary and timeline. The user can retry from
  a known state instead of guessing what happened.
- Normal code: app authors write JavaScript modules that export jobs and
  tools. The manifest stays small and static. Skills are markdown files.
- Great errors: every app-runtime error should name the app, capability,
  action, and fix when possible.

## App States

App state is intentionally split into separate concepts:

| State | Meaning |
|---|---|
| Available | The app exists in a direct origin and has a readable manifest. |
| Enabled | This person has activated the app for the local Project checkout. |
| Loaded | The backend module has been imported and descriptors are available. |
| Active | A view, job, or tool call from the app is currently in use. |

Available does not imply enabled. Enabled does not imply UI is open. Headless
tool and skill apps are expected.

## Manifest V1

The manifest is a stable envelope, not the programming model. It answers only
questions the shell must know before executing app code: identity, view pane
roles, terminal and backend entries, compatibility, and declared permissions.

Use `package.json` with a `mim` block:

```json
{
  "name": "@mim/stats-checker",
  "version": "0.1.0",
  "type": "module",
  "mim": {
    "manifestVersion": 1,
    "id": "stats-checker",
    "name": "Stats Checker",
    "description": "Statistical review tools for chat and data workflows.",
    "icon": "SC",
    "views": [],
    "tui": { "entry": "./tui/index.mjs" },
    "backend": "./backend/index.mjs",
    "permissions": {
      "workspace": { "read": true, "write": false },
      "ai": true,
      "http": ["api.openalex.org", "*.crossref.org"],
      "secrets": []
    },
    "engines": {
      "mim": "runtime-v1"
    }
  }
}
```

Rules:

- Each view must declare `role: "work"`, `"artifact"`, or `"either"`.
- Work views appear in Navigator and open in the Work pane.
- Artifact views are opened only by explicit Work-surface actions.
- `views` is optional and may be empty.
- `tui` is optional. Its entry must be an existing module under `tui/` that
  exports `run(context)`; `mim tui <app>` loads it only for an enabled app in an
  interactive terminal.
- `backend` is optional. A UI-only app does not need backend code.
- Permissions are declarative because the shell must know them before loading
  backend code.
- Jobs, tools, data collections, and workflow schemas do not belong in
  manifest v1. They are backend exports. Skills are `skills/<name>/SKILL.md`
  files, not exports.
- Normal `package.json` keys are allowed. Unknown keys inside `mim` should
  fail validation, except `x-*` extension keys.
- There is no separate manifest format in v1.

This avoids a fragile mini-language while preserving static discovery and
permission review.

## Backend Capabilities

Backend code is normal JavaScript. The runtime imports the backend module only
when the app is enabled and capabilities are needed. V1 must accept plain
descriptor objects so app authors do not need a build step or a helper
dependency.

```js
export const jobs = {
  checkCsv: {
    label: 'Check CSV',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    },
    concurrency: 'single',
    async run(ctx, input) {
      await ctx.progress.step('Reading data')
      const csv = await ctx.files.readWorkspaceText(input.path)
      const report = runChecks(csv)
      await ctx.data.collection('reports').put(ctx.job.runId, report)
      return report
    }
  }
}

export const tools = {
  checkDataset: {
    label: 'Check dataset',
    description: 'Inspect a CSV for missingness, impossible values, and statistical anomalies.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    },
    audience: ['chat'],
    async execute(ctx, input) {
      const csv = await ctx.files.readWorkspaceText(input.path)
      return runChecks(csv)
    }
  }
}

export const agents = {
  reviewer: {
    name: 'Reviewer',
    tools: ['fs.read'],
    async instructions(ctx) { return 'You review documents.' }
  }
}
```

The `agents` export is parsed alongside `jobs` and `tools` by `parseAgents` in
`packageRuntime.ts`. Shape validation (structural diagnostics) happens at parse
time; semantic validation (tool id existence, model lookup) happens at mount
time in `agentMounts.ts`.

Later, `defineJob` and `defineTool` can be added as optional
descriptor helpers for stronger editor autocomplete and clearer authoring
errors. They should remain zero-magic helpers, not a framework requirement.

## Architecture

```txt
PackageLoader
  reads package.json mim blocks
  validates static manifest
  reports available apps, origins, overrides, and diagnostics

EnabledPackageStore
  records which apps are enabled for this workspace
  persists under .mim/packages/enabled.json

PackageRuntime
  imports enabled backend modules on demand
  validates exported jobs and tools
  validates tool inputs and builds app-scoped runtime ctx

CapabilityRegistry
  indexes enabled app jobs/tools
  exposes descriptors to app UI, chat, and command surfaces

PackageJobRunner
  starts/cancels jobs
  emits progress events
  persists run summaries and timelines
  keeps ephemeral runs in memory only, no record

PackageServer + SDK
  serves app views
  authenticates launch tokens
  routes runtime RPC and job events

Chat Tool Builder
  combines core tools with enabled app chat tools
  executes app tools through PackageRuntime ctx
```

## Identity And Trust

Current app WebSocket identity is claim-based. Runtime v1 must replace it
with launch tokens.

Flow:

1. Renderer asks main for a launch URL for app view `stats-checker`.
2. Main creates a short-lived launch token bound to app id and view id.
3. Iframe loads `/packages/stats-checker/index.html?launch=...`.
4. SDK identifies with the launch token.
5. Server binds that WebSocket connection to the app identity.

Requirements:

- An app iframe cannot forge another app id.
- Tokens are bound to app/view identity. An unused token must complete a
  first identify within a short window (60s); after a successful identify the
  token stays valid for the server lifetime, because the renderer keeps iframe
  launch URLs alive indefinitely and iframe reloads / SDK reconnects replay the
  same token. (See "Package launch tokens" in `docs/gotchas.md`.)
- Backend job/tool calls from app UI never accept a forged `packageId` from
  caller params. The runtime injects identity from the authenticated context.
- App tools and jobs are unavailable when the app is disabled.
- App file access is constrained by declared manifest permissions before it
  reaches the normal approval gate.

## Runtime Context

Backend jobs and tools receive an app-scoped context:

```js
ctx.package        // { id, name, version, source }
ctx.job            // { id, runId, startedAt } for jobs, null for tools
ctx.inputs         // frozen input object for jobs
ctx.data           // kv and collection storage
ctx.files          // app resource reads and workspace text reads
ctx.ai             // model calls through main-process key resolver
ctx.documents      // document helpers such as DOCX read/annotate and PDF text extraction
ctx.http           // permission-checked fetch
ctx.secrets        // manifest-declared keychain secrets
ctx.progress       // step, log, progress, done
ctx.audit          // explicit audit records
ctx.abort          // signal, aborted, throwIfAborted()
ctx.tools          // constrained calls into core tool registry
```

Current runtime implements `package`, `job`, `inputs`, `data`, `files`,
`progress`, `audit`, `abort`, constrained `tools`, `ctx.ai.generateObject`,
`ctx.ai.callAnthropic`, `ctx.ai.callGemini`, `ctx.documents.docx`,
`ctx.documents.pdf`, `ctx.http`, and `ctx.secrets`. `ctx.http` enforces the manifest host allowlist and HTTPS
(`src/main/packages/packageHttp.ts`); `ctx.secrets` reads and writes manifest-declared
keychain secrets (`src/main/packages/packageSecrets.ts`). See
[app-system-api.md](app-system-api.md) for the contract details.

Document helpers are intentionally under `ctx.documents`, not directly on the
core context. They still call main-process tools, so path checks, app
permissions, approval policy, and audit behavior stay centralized.

## App Data

Workspace-scoped data lives under:

```txt
{workspace}/.mim/packages/{packageId}/
  data/
    kv/
    collections/
  runs/
```

V1 storage should use atomic JSON file writes:

```js
await ctx.data.kv.get('settings')
await ctx.data.kv.set('settings', value)
await ctx.data.kv.delete('settings')
await ctx.data.kv.keys()

const reports = ctx.data.collection('reports')
await reports.put(id, value)
await reports.get(id)
await reports.delete(id)
await reports.list()
```

Use file-backed JSON first. Do not introduce SQLite for app data until a
real app proves query needs that JSON cannot satisfy cleanly.

## Job Runner

Job runner API:

```js
runtime.jobs.start('checkCsv', { path: 'data.csv' })
runtime.jobs.cancel(runId)
runtime.jobs.get(runId)
runtime.jobs.list()
runtime.jobs.on(runId, callback)
```

Run lifecycle:

```txt
queued -> running -> completed
                  -> failed
                  -> cancelled
```

Events:

```txt
job.started
job.step
job.log
job.progress
job.done
job.failed
job.cancelled
```

Rules:

- Default concurrency is one active run per `{packageId, jobId}`.
- Jobs receive an `AbortSignal`.
- Cancellation is reflected in UI immediately, even if cleanup continues.
- Every run stores a summary and event timeline under app run storage.
- Job errors include app id, job id, run id, and original error message.

## App Tools In Chat

Enabled app tools become first-class chat tools:

```txt
core.search
core.fs.read
pkg_1a2b3c4d__checkDataset
pkg_5e6f7a8b__searchLiterature
```

Execution flow:

```txt
chat tool builder asks CapabilityRegistry for enabled chat tools
  -> AI SDK receives collision-safe app tool definitions
  -> model calls pkg_1a2b3c4d__checkDataset
  -> PackageRuntime builds ctx for stats-checker
  -> tool executes with permissions, audit, output caps, cancellation
  -> ChatMessage renders the same tool-call UI with app provenance
```

UX requirements:

- Available app tools are not silently active. The app must be
  enabled.
- Tool calls show provider: "Check dataset, provided by Stats Checker."
- Permission prompts name the app: "Stats Checker wants to read data.csv."
- Tool settings can disable an app or individual app tool.
- Audit records include app id and tool id.

## Skills

App skills are filesystem skills: `{package}/skills/<name>/SKILL.md` in the
format described in [skills.md](skills.md), available only while the app is
enabled. Backend `export const skills` is ignored.
Skills may reference app tools, which still execute under app identity
and permissions.

## SDK Shape

`sdk/mim.js` should grow from raw RPC into a small app SDK:

```js
runtime.package.id
runtime.package.name

runtime.jobs.start(jobId, inputs)
runtime.jobs.cancel(runId)
runtime.jobs.get(runId)
runtime.jobs.list()
runtime.jobs.on(runId, callback)

runtime.data.kv.get(key)
runtime.data.kv.set(key, value)
runtime.data.collection(name)

runtime.tools.list()

runtime.workbench.openWork(viewId)
runtime.workbench.openRun(runId)
runtime.workbench.openArtifact(viewId)

runtime.call(method, params) // escape hatch
runtime.on(event, callback)
runtime.off(event, callback)
```

`runtime.call()` remains for low-level escape hatches, but it should not be the
happy path for jobs, data, tools, or Workbench navigation.

App skills use the filesystem skill system: `{package}/skills/<name>/SKILL.md` with canonical id `packageId:name`. See [skills.md](skills.md).

## Decisions

Settled for v1:

- Use `package.json` with a small `mim` block as the static manifest.
- Keep jobs and tools in backend JavaScript exports, not in the manifest.
  Skills are `skills/<name>/SKILL.md` files (see [skills.md](skills.md)).
- Support headless apps.
- Allow enabled app tools to become first-class chat tools even when no
  app UI is active.
- Execute backend modules in the Electron main process initially. Revisit
  worker or child-process isolation when untrusted third-party apps become a
  real requirement.
- Store app data and run history as workspace-scoped JSON files first.
- Use launch tokens for app iframe identity.
