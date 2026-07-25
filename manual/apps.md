---
id: apps
title: apps
order: 10
sources:
  - README.md
  - docs/custom-apps.md
  - src/main/packages/packages.ts
  - src/main/tools/coreApps.ts
  - src/renderer/components/settings/AppsSettingsPanel.vue
verified: direct-team-source
---

# apps

Apps extend Mim with views in the Navigator, tools the agent can call, skills,
agent profiles, and background jobs. Each app view runs in a sandboxed iframe,
and app calls pass through the same permission gate as other tools.

## The catalog

Open Settings > Apps & agents. Mim shows apps from three origins:

- Mim apps shipped with the application;
- apps shared by your connected Team;
- apps authored in the current Project.

When an app id appears more than once, the Project copy overrides the Team
copy, and the Team copy overrides Mim's. The row shows the winning origin.

Active in this Project lists apps you have enabled in this local checkout.
Available lists the rest. The choice is yours: a teammate can enable a
different set without either choice changing shared files or appearing in Git.

Expand a row to review its access, version, update owner, documentation,
capabilities, and developer diagnostics. Team and Project apps that contain
code or request file, network, secret, or AI access show a local permission
review before first use.

Team apps arrive in a Team release that lists what changed before you select
Update. An app that asks for new access requires review again. Project apps
update with the Project; Mim apps update with Mim itself.

If your Team apps are not visible yet, start with [team](team). Connecting a
Team makes its apps available; it does not enable them automatically.

## CLI agents

Detected CLI agents appear below the app catalog in the same tab. Their toggles
control Navigator launchers for the current Project. Custom flags and Mim tool
connection details remain available under Customise.

## Making your own

Click New app in Apps & agents. Choose a starter template, an id and display
name, then choose the current Project or the connected Team as its destination.
Project apps live in `packages/<id>/`; Team apps live in the Team repository's
`apps/<id>/`.

From there, edit the app files and ask the agent to validate and reload it.
Project and Team apps are ordinary writable source files. Mim-shipped apps are
read-only.

::: under-the-hood
An app is a directory with a `package.json` manifest declaring its id, views,
permissions, and optional backend. Local activation lives only in
`.mim/packages/enabled.json`. The direct-source loader watches Mim, Team, and
Project roots and resolves Project > Team > Mim.

More in [app system and API](/develop/app-system-api).
:::
