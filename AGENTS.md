# Agent Instructions

## Ownership

Every coding agent is responsible for the entire repo, not just their current task. "Pre-existing" and "out of scope" are not excuses to disregard broken or suboptimal code. If you encounter an issue, fix it if small, or log it in `.private/issues.md` (gitignored, local) if it requires a separate effort. Always think holistically and take full responsibility for the success of the entire application.


## Backward Compatibility

Some features may not need to be backwards compatible. Always ask if backwards compatibility is needed.

## No Screenshots

Never attempt to take screenshots via `screencapture`, `osascript`, or any other tool. When verifying UI changes, describe exactly what needs checking and ask the user to confirm visually.


## Coding Conventions

**TDD.** Tests are co-located: `foo.ts` tested by `foo.test.ts` in the same directory. Write the test file first with failing tests that describe the contract, then implement until they pass.

**Testing rules.** Mock only at system boundaries (Electron IPC, AI SDK providers). Use real Pinia stores. No snapshot tests. Run: `npm run test`. The suite includes `src/**/*.test.ts` plus co-located `*.test.{ts,mjs}` under `sdk/` and `scripts/` (see `vitest.config.ts`). Each optional Team repository runs its own app tests. To verify a Team against current Mim, run `MIM_TEAM_PATH=/path/to/team npm run test:team:compat`; it stages every app published in `team-index.json` into a temporary Team layout and exercises the real app loader/runtime, named-tool path, and app-root `compat.mjs` smoke hooks.

**Styles — TAILWIND ONLY.** All styling MUST use Tailwind v4 utility classes. Design tokens are defined in `src/renderer/styles.css` via `@theme`. Use the project's semantic classes: `text-ink-3`, `bg-chrome-mid`, `border-rule-light`, `bg-surface`, `text-accent`, etc.

**DO NOT** write `<style>` blocks with `var(--color-*)` or raw CSS properties for layout, spacing, colors, or typography. **DO NOT** use inline `style=""` attributes. If you are touching a component that has existing `<style>` CSS, migrate it to Tailwind utilities while you are there.

`<style>` blocks are permitted ONLY for: `@keyframes` animations, vendor-prefixed properties (`-webkit-app-region`), and `:deep()` selectors targeting third-party content (CodeMirror, rendered markdown, xterm).

**Interaction.** Native desktop cursor conventions: no `cursor: pointer` on any control (arrow cursor everywhere). Pointer cursor is only for `<a>` hyperlinks. Every clickable element must have a `hover:bg-*` background change as its affordance. See [docs/design-system.md](docs/design-system.md) §7 for the full interaction contract.

**State.** Vue 3 Composition API. Pinia setup stores. Strongly prefer using stores directly over emits or prop drilling — if a store exists for the data, import it in the child component. Props/emits are for truly local parent-child contracts only. Import `useSettingsStore()` directly — no provide/inject.

**UI primitives.** Shared, themed controls live in `src/renderer/components/ui/` (Headless UI + floating-ui under the hood). Use `MimSelect` instead of a native `<select>` or a bespoke listbox; use `MimDialog` for app modals; use `MimMenu` / `MimMenuItem` for action menus; use `MimContextMenu` for right-click menus. See [docs/design-system.md](docs/design-system.md) §6.11-6.14.

**File I/O.** All file access goes through `window.kernel.call()` via the preload bridge. Never use Node `fs` or browser File API.

**Docs.** When changing a subsystem, update the relevant doc and `docs/_MAP.md`. Docs describe current state, not history. Git tracks what was deleted. Never put counts that change over time into docs.

**AI-native coding.** AI owns the code and the docs. See [AGENTS.md](AGENTS.md) for agent-specific rules.

**AI tools.** When defining tools with the Vercel AI SDK `tool()` function, ALWAYS use `inputSchema` — NEVER `parameters`. Using `parameters` silently breaks Anthropic (400 error: `input_schema.type: Field required`). See [docs/gotchas.md](docs/gotchas.md).


## Navigation

- Start at [docs/_MAP.md](docs/_MAP.md) for file paths and system lookup.
- Read [docs/history.md](docs/history.md) and [docs/git.md](docs/git.md) before changing recovery, pruning, git, or sync behavior.
- Read [docs/observability.md](docs/observability.md) for trace logging, audit events, retention, and agent-facing trace tools.
- Read [docs/telemetry.md](docs/telemetry.md) for anonymous usage telemetry, privacy invariants, endpoint config, and kill switches.
- Read [docs/custom-apps.md](docs/custom-apps.md) before changing the user-facing flow for building workspace skills or custom apps.
- Read [docs/gotchas.md](docs/gotchas.md) for non-obvious constraints.
- Whenever you work on frontend / UI, check [docs/design-system.md](docs/design-system.md).
