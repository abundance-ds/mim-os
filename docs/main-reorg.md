# `src/main/` layout

`src/main/` keeps Electron entrypoints and small singleton services at the root,
and groups larger platform domains into subfolders. Core owns the app platform,
while optional Team repositories and Projects own their app-specific issue,
knowledge, and company workflow models.

## Root files

- `index.ts` — Electron app boot and IPC wiring.
- `cli.ts`, `headless.ts` — headless CLI entrypoints.
- `logbook.ts`, `sessions.ts`, `skills.ts`, `attachments.ts`,
  `git.ts`, `menu.ts`, `pty.ts`, `userConfig.ts` — small singleton services.

## Domain folders

- `ai/` — model registry, central runtime, agent context, system prompt.
- `packages/` — package loader, manifest validation, enablement, runtime, jobs,
  data, HTTP, and secrets.
- `team/` — one Team source contract and Project mount.
- `search/` — SQLite session search, file content search, message text rows, and
  text matching.
- `security/` — permission gate and path classifier.
- `trace/` — unified trace stream (spans, identity, payload blobs, sinks).
- `server/` — Express/WebSocket server and AI endpoint tests.
- `workspace/` — boot workspace resolution, `mim.yaml` contract, scoped open-file watcher.
- `tools/` — tool registry plus concrete tool modules.

## Import convention

Main-process code uses the `@main/*` alias for imports inside `src/main`.
The alias is configured in `tsconfig.json`, `electron.vite.config.mjs`, and
`vitest.config.ts`. Keep explicit `.js` import extensions.

## Verification

`src/main/mainReorg.test.ts` enforces the grouped layout, keeps app-specific
models out of core, and statically resolves every local `src/main` import and
`vi.mock()` target.

Run:

```bash
npm run test
npm run build
```
