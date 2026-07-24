# Custom apps

Custom apps are file-native capability bundles authored for one Project or
shared through the connected Team source. Mim also ships built-in apps. There
is no app registry, source list, global install cache, or shared activation
flag.

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

Connecting or syncing a Team refreshes the live app catalog. It does not
silently enable new apps: open Settings -> Apps & agents, review a Team app's
declared permissions, and enable it for the current Project. Only enabled apps
with a view receive Navigator launchers. App source and app data are separate;
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
  backend/
    index.mjs
  skills/
    optional-skill/
      SKILL.md
```

UI, backend, skills, and README are optional. `package.json` is required.
Use `package.validate` after edits and `package.reload` to rescan the catalog,
invalidate runtime caches, and refresh named tools.

## Editing and validation

Project and Team apps are writable. Mim apps are read-only. App editing,
deletion, README access, runtime validation, capability inspection, backend
jobs, named tools, agent profiles, and the SDK remain the same regardless of
origin.

Apps that contain a backend or request effective permissions require a local
permission review before first activation when they come from Project or Team.
Mim-shipped apps are trusted by origin. The acknowledgement is local and does
not create a source trust system.

## Updates

Project apps update with Project sync, Team apps with Team sync, and Mim apps
with the Mim application updater. The app catalog watches all three roots and
rescans after file changes. No per-app registry download lifecycle exists.

## Related docs

- [App system API](app-system-api.md)
- [Package runtime](package-runtime.md)
- [Skills](skills.md)
- [Team source and setup](team.md)
