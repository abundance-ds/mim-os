# App system and SDK

Mim apps are local capability bundles discovered directly from the Mim build,
the connected Team checkout, and the current Project. The system has two
separate decisions:

- origin determines where an app is available and who authors it;
- local activation determines whether it contributes views, tools, jobs,
  skills, and agents for this person in this Project checkout.

## Architecture

| Part | Owner |
|---|---|
| Manifest parser | `src/main/packages/packageManifest.ts` |
| Direct-source loader and watchers | `src/main/packages/packages.ts` |
| Local activation and permission acknowledgement | `src/main/packages/packageEnablement.ts` |
| Runtime, jobs, data, HTTP, secrets | `src/main/packages/packageRuntime.ts`, `packageJobs.ts`, `packageData.ts`, `packageHttp.ts`, `packageSecrets.ts` |
| Named tools and agent profiles | `src/main/packages/namedPackageTools.ts`, `src/main/ai/agentMounts.ts` |
| App management tools | `src/main/tools/packages.ts`, `src/main/tools/coreApps.ts`, `src/main/tools/packageRuntime.ts` |
| Terminal UI host | `src/main/tui/packageTui.ts` |
| Renderer SDK | `sdk/mim.js`, `sdk/mim.d.ts`, `sdk/tokens.css` |

## Discovery and precedence

| Origin | Root | Rank |
|---|---|---:|
| Mim | packaged `resources/apps/` | 1 |
| Team | `~/.mim/team/apps/` | 2 |
| Project | `<project>/packages/` | 3 |

Each root is flat: `<root>/<id>/package.json`. The highest-ranked valid
manifest wins. Shadowed copies remain diagnostic information. The loader
checks the declared Mim runtime engine, records malformed manifests without
blocking other apps, watches all present roots, and serialises overlapping
rescans.

## Manifest

The app contract lives under the `mim` key in `package.json`:

```json
{
  "name": "@mim/example",
  "version": "1.0.0",
  "type": "module",
  "mim": {
    "manifestVersion": 1,
    "id": "example",
    "name": "Example",
    "description": "Example app",
    "views": [
      {
        "id": "main",
        "label": "Example",
        "src": "./ui/index.html",
        "role": "work"
      }
    ],
    "tui": {
      "entry": "./tui/index.mjs"
    },
    "backend": "./backend/index.mjs",
    "permissions": {
      "workspace": { "read": true, "write": false },
      "ai": false,
      "http": ["api.example.com"],
      "secrets": ["api_token"]
    },
    "provides": {
      "tools": [
        { "pattern": "example.*", "category": "read", "risk": "low" }
      ]
    },
    "dataFolder": "example-data",
    "engines": { "mim": "runtime-v1" }
  }
}
```

App ids use lowercase letters, digits, `_`, and `-`. Views may use `work`,
`artifact`, or `either`. UI, terminal UI, and backend paths must stay within
the package. A `tui.entry` must live under the app's `tui/` directory, exist at
validation time, and export `run(context)`. The interactive CLI launches it
with `mim tui <app>` and supplies the terminal toolkit plus an app-attributed
tool caller. Knowledge also has the shortcut `mim k`.
`dataFolder`, when present, is a single safe Project-relative folder created
on enablement and never deleted by disabling the app.

## Local activation

All origins default to disabled. `app.enable` and `app.disable` write only:

```json
{
  "enabled": ["example"],
  "disabled": [],
  "trusted": [
    {
      "id": "example",
      "grants": ["code.backend", "workspace.read"]
    }
  ]
}
```

at `<project>/.mim/packages/enabled.json`. The file is private runtime state.
It is not a Project or Team declaration.

Project and Team apps with a backend, terminal UI, or effective workspace, AI,
HTTP, or secret permissions need local permission acknowledgement. `app.trust`
records the exact reviewed grant tokens. An update that adds access requires a
new review; an update that keeps or reduces access remains trusted. Mim apps do
not require this prompt.

## Management tools

| Tool | Contract |
|---|---|
| `app.status` | Lists every available winner with origin, version, activation, permission-review state, override state, and data-folder presence |
| `app.enable` / `app.disable` | Changes local activation for the current Project checkout |
| `app.trust` | User acknowledgement of one Team or Project app's declared access |
| `app.agents.list` | Lists agent profiles from enabled apps |
| `app.templateList` / `app.templateContent` | Lists and renders built-in starter templates |
| `package.create` | Creates an app in `destination: "project" | "team"` |
| `package.edit` / `package.delete` | Mutates a Project or Team app; Mim apps are read-only |
| `package.validate` | Checks the manifest, backend exports, skills, grants, paths, and permission hints |
| `package.reload` | Rescans origins, invalidates runtime state, synchronises named tools, and emits change events |
| `package.list` / `package.readme` | Returns catalog metadata or root README content |
| `package.capabilities.list` | Returns enabled jobs, tools, agents, skills, and runtime diagnostics |
| `package.jobs.start` | Starts a backend job |
| `package.tools.execute` | Executes an enabled named app tool |

Registry, install, update, uninstall, account-entitlement, source-list, and
workspace-sharing tools do not exist. Project, Team, and Mim updates arrive
through their owning source lifecycle.

## Backend exports

An app backend can export:

```js
export const jobs = {
  refresh: {
    label: 'Refresh',
    concurrency: 'single',
    async run(ctx, input) {
      await ctx.data.write('latest', input)
      return { ok: true }
    }
  }
}

export const tools = {
  inspect: {
    name: 'example.inspect',
    description: 'Inspect example data',
    inputSchema: { type: 'object', properties: {} },
    async execute(ctx) {
      return ctx.data.read('latest')
    }
  }
}

export const agents = {
  helper: {
    name: 'Example helper',
    async instructions() {
      return 'Help with example work.'
    }
  }
}
```

The runtime supplies scoped APIs for app data, Project files, HTTP, secrets,
AI, documents, logs, and approved core tools. Values crossing the boundary are
validated and bounded. Backend modules are cached until reload.

App-owned runtime data and run records live under
`<project>/.mim/packages/<id>/`. Secrets live in the OS keychain under the
package id and declared secret name.

## Renderer SDK

App UI imports `/sdk/mim.js`:

```js
import { runtime } from '/sdk/mim.js'

const info = await runtime.workspace.info()
const result = await runtime.jobs.start('refresh', { full: true })
runtime.on('packages:changed', () => location.reload())
```

The SDK covers workspace/file reads and writes allowed by the manifest,
package jobs and tools, app data, AI, document helpers, secrets status, editor
handoff, work/artifact routing, browser-safe HTTP, and events. Prefer named SDK
methods over raw `runtime.call()`. App frames are sandboxed and requests are
checked against the app's manifest and the ordinary permission gate.

## UI and development

Settings -> Apps & agents is the only catalog. It shows Active and Available
rows, the actual Project/Team/Mim origin, local toggles, declared access,
documentation, capabilities, runtime diagnostics, and detected CLI agents.
Creating an app chooses only Project or Team.

For local development:

1. create or edit the app directory;
2. run `package.validate`;
3. run `package.reload`;
4. enable it in Apps & agents after reviewing access;
5. inspect Developer details for loader and runtime diagnostics.

Compatibility with an optional Team repository is exercised by
`MIM_TEAM_PATH=/path/to/team npm run test:team:compat`, which stages every app
listed in that Team's release index and runs loader/runtime/tool smoke hooks.
