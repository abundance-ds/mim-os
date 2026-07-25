# Custom apps

Custom apps are file-native capability bundles authored for one Project or
shared through the connected Team. Mim also ships built-in apps. There
is no app registry, source list, global install cache, or shared activation
flag.

## Choose a skill before an app

Use the smallest durable abstraction that solves the recurring task:

- Use a skill when existing tools already provide the required capability and
  Mim only needs reusable instructions, learned preferences, or a repeatable
  workflow.
- Use an agent profile when the work needs a separate identity, sessions,
  model, or narrower tool scope.
- Use an app only when the capability genuinely needs new executable logic,
  persistent structured data, background jobs, or a dedicated interface.

For example, learning how a person writes email is a Personal skill over the
existing Gmail tools. It does not require a mailbox mirror, drafting database,
or email UI.

## Origins and precedence

Apps are discovered directly from:

```text
Mim build resources/apps/<id>/
~/.mim/team/apps/<id>/
<project>/packages/<id>/
```

When the same id exists more than once, Project overrides Team and Team
overrides Mim. Settings -> Apps & agents shows the winning origin and exposes
the shadowing diagnostic in Developer details.

Availability and activation are separate. Team apps are available in every
Project, Project apps are available only there, and Mim apps travel with the
application. Each person activates any of them independently for each local
Project checkout. The choice lives only in:

```text
<project>/.mim/packages/enabled.json
```

That file is gitignored. An activation toggle never edits `mim.yaml`,
`team.yaml`, or another person's state.

Connecting or accepting a Team update refreshes the live app catalog. It does
not silently enable new apps: open Settings -> Apps & agents, review a Team
app's declared permissions, and enable it for the current Project. Only enabled
apps with a view receive Navigator launchers. App source and app data are separate;
for example, a Team-provided Board still reads the current Project's `issues/`
directory.

## Creating an app

Settings -> Apps & agents -> New app asks for:

- a starter template;
- an app id and name;
- Project or the connected Team as the destination.

The same operation is available through `package.create` with
`destination: "project" | "team"`. Project apps are created under
`packages/<id>/`; Team apps under `~/.mim/team/apps/<id>/`.

An app is an ordinary directory:

```text
my-app/
  package.json
  README.md
  ui/
    index.html
  tui/
    index.mjs
  backend/
    index.mjs
  skills/
    optional-skill/
      SKILL.md
```

Iframe UI, terminal UI, backend, skills, and README are optional.
`package.json` is required. A terminal UI is declared as
`"tui": { "entry": "./tui/index.mjs" }`, exports `run(context)`, and launches
with `mim tui <app>` after the app is enabled. The module receives the shared
terminal toolkit and an app-attributed `call()` function; it should not bundle
its own copy of the toolkit or bypass Mim's tool registry.
Use `package.validate` after edits and `package.reload` to rescan the catalog,
invalidate runtime caches, and refresh named tools.

## Editing and validation

Project and Team apps are writable. Mim apps are read-only. App editing,
deletion, README access, runtime validation, capability inspection, backend
jobs, named tools, agent profiles, and the SDK remain the same regardless of
origin.

Apps that contain executable backend or terminal UI code, or request effective
permissions, require a local permission review before activation when they
come from Project or Team. The acknowledgement stores the exact reviewed
access. An update that expands access requires review again; unchanged or
reduced access does not. Mim-shipped apps are trusted by origin.

## Updates

Project apps update with their Project, Team apps arrive in a person-approved
Team release, and Mim apps update with the Mim application updater. A Team
release lists all app changes from `team-index.json`; apps are not downloaded
or updated independently.

## Related docs

- [App system API](app-system-api.md)
- [Package runtime](package-runtime.md)
- [Skills](skills.md)
- [Team and setup](team.md)
