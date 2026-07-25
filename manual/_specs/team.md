# Spec: team (order 4)

Purpose: explain in plain language how to connect, update, use, and optionally
create one company Team.

## Outline

- A Team is an optional company repository; it is not global Mim content.
- Explicit safety boundary: connecting or updating does not move or delete
  Project data such as `issues/` or `knowledge/`.
- Setup: system Git access, credential-free HTTPS or SSH URL, Settings > Team.
- Release journey: quiet check, change summary, one Update action, exact access
  re-review on permission expansion.
- Folder structure, including `team.yaml` and generated `team-index.json`.
- What appears where.
- Availability versus activation, local permission review, and why an app may
  be available without a Navigator launcher.
- Writable checkout, background publishing, and conflict-safe updates.
- Short troubleshooting section.

## Boundaries

No internal implementation tour beyond the under-the-hood block. Do not teach
Git fundamentals or imply that Team Git backs up Project files.

## Sources

- docs/team.md
- docs/git.md
- src/main/team/teamSource.ts
- src/main/team/teamFiles.ts
- src/renderer/components/settings/TeamSettingsPanel.vue

## Length

700–1100 words.
