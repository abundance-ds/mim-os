# Spec: apps (order 10)

Purpose: extending Mim — using apps from direct origins and making your own.

## Outline

- What an app is: an installable unit that can add views to the sidebar, tools the
  agent can call, skills, and background jobs. Apps run sandboxed and call the same
  permissioned tools as everyone else — one sentence, calm.
- Ownership: Mim may bundle core apps, while each optional Team and Project
  owns its own app set. Do not present one company's Team as a global catalog.
- Availability: Mim apps come from the build, Team apps from `apps/`, and
  Project apps from `packages/`; Project overrides Team, which overrides Mim.
- Activation: Settings > Apps & agents provides permission review and a local
  enable/disable toggle. Activation never changes Team or Project state.
- Making your own: Settings > Apps & agents creates a starter app from a template into the
  Project or Team; edit, validate, reload. Skills as the lighter option —
  point back to [agents](agents) for what skills are, forward to
  docs/custom-apps.md-derived /develop content for the full authoring story.
- Trapdoor: manifest, SDK, named tools → /develop (app SDK & API).

## Boundaries

No SDK detail, no manifest fields, no job API (→ /develop). No skill-usage
explanation (→ agents).

## Sources

- README.md (Apps)
- docs/custom-apps.md
- src/main/packages/packages.ts
- src/main/tools/coreApps.ts
- src/renderer/components/settings/AppsSettingsPanel.vue

## Length

800–1200 words.
