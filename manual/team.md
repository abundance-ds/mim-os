---
id: team
title: team
order: 4
sources:
  - docs/team.md
  - docs/git.md
  - src/main/team/teamSource.ts
  - src/main/team/teamRelease.ts
  - src/renderer/components/settings/TeamSettingsPanel.vue
verified: optional-team-updates
---

# team

A Team is an optional company repository. It can add company apps, skills,
routines, shared files, and guidance to Mim. You can use Mim without one.

Each company owns its own Team. Connecting one company’s repository does not
make that repository part of Mim itself, and other companies receive none of
its content.

::: note
Connecting or updating a Team does not move or delete Project data. A
Project’s `issues/`, `knowledge/`, documents, chats, and `.mim/` state stay
where they are.
:::

## Connect your Team

Open Settings > Team, paste the **Team link** supplied by your company, and
select **Connect Team**. Mim accepts credential-free HTTPS or SSH links and
uses the Git credentials already configured on your computer.

When connection succeeds, the Team says **Up to date**. Its apps become
available in Settings > Apps & agents, but do not run until you review and
enable them for the current Project.

## Receive updates

Mim checks quietly. If the company publishes a new release, Team settings says
**Update available** and lists exactly what changed: apps, skills, routines,
files, or guidance.

Select **Update** to install the release. That is the only normal action. A
Team app that asks for additional access is called out and cannot run with its
old approval. Updates that keep or reduce access do not ask again.

After installation, Team settings says **Updated**, then returns to **Up to
date**. Repository and folder details are available under **Developer
details** when needed.

## What the Team adds

::: rows
- Files — shared company files appear in Files under the Team’s name.
- Guidance — standing company instructions join the agent’s instructions.
- Skills — Team skills appear in Settings > Skills and Chat.
- Apps — Team apps appear in Settings > Apps & agents for local review and
  activation.
- Routines — Team routines appear alongside Project routines and are activated
  per machine.
:::

Available and active are different. Another colleague can enable a different
set of apps without changing the Team repository or your settings. App code
also remains separate from app data: a Team-owned Knowledge app can still read
the open Project’s `knowledge/` folder.

## Create a company Team

Use an existing Team repository as a template. The release workflow maintains
the generated index.

```text
team.yaml
team-index.json
instructions.md
files/
skills/<name>/SKILL.md
apps/<id>/package.json
routines/
```

Only the company connects that repository. Apps and standalone skills carry
versions; the repository workflow validates all contributions, runs tests,
bumps changed versions when needed, and publishes one release index.

## Troubleshooting

::: rows
- No app launcher — open Settings > Apps & agents and enable the app for this
  Project. An app without a view never has a launcher.
- No app in Settings — confirm the Team says Up to date, then select
  **Refresh apps** in Settings > Apps & agents.
- Cannot connect — make `git ls-remote <team-link>` work in a terminal first.
  Never put a token in the link.
- Update needs attention — open Developer details and the Team folder. Mim
  preserves both conflicting versions so you can keep the intended content.
:::

More on app activation is in [apps](apps).

::: under-the-hood
The Personal connection is stored in `~/.mim/config.yaml`; the checkout lives
at `~/.mim/team/`. `team-index.json` is the release boundary. A check fetches
metadata without changing installed content, and an accepted update refreshes
apps, skills, routines, and files together.
:::
