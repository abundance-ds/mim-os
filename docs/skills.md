# Skills

Mim loads filesystem skills from four authored origins and app packages. An
authored skill is a directory containing `SKILL.md`; supporting files may sit
beside it.

## Authored origins and precedence

Authored skills resolve by folder/frontmatter name, from least to most
specific:

1. **Mim** — bundled skills from the application build.
2. **Team** — `~/.mim/team/skills/`.
3. **You** — `~/.mim/skills/`.
4. **Project** — `<project>/skills/`.

The later definition wins. The detailed catalog retains the shadowed metadata
for explanation, but Chat activates only the winning definition. App-bundled
skills use package-qualified ids and remain a separate namespace.

Settings → Skills presents the resolved authored catalog as one searchable
list. It uses the current Project name, the actual Team name, **You**, and
**Mim** as origin labels. Each user's enable/disable choices are stored in
`skills.disabled` in `~/.mim/config.yaml`; toggles never edit Team or Project
content.

New skills can be created in You, Project, or Team. Clicking any row opens its
`SKILL.md` in the normal document editor. Project, Team, and Personal skill
documents save normally. Mim skills open read-only.

## Editor paths

Project and Team skill documents already have Project-relative paths:

- `skills/<name>/SKILL.md`
- `.mim/team/skills/<name>/SKILL.md`

Mim gives Personal and built-in documents narrow managed paths so the existing
editor, watcher, stale-write check, and save flow can be reused without
granting general access outside the Project:

- `.mim/origins/you/skills/<name>/SKILL.md`
- `.mim/origins/mim/skills/<name>/SKILL.md`

Only these exact origin mounts bypass the filesystem symlink-escape guard.
Apps cannot access Personal or Mim origin documents, and every actor is denied
writes to Mim built-ins.

## `SKILL.md`

Every skill begins with YAML frontmatter:

```markdown
---
name: review-notes
description: Use when reviewing research notes for gaps and contradictions.
tools: [fs_read]
unlocks: [comments_add]
---

# Review notes

Follow the instructions here.
```

- `name` is required and must match the directory name.
- `description` is required and is shown in the catalog/system prompt.
- `tools` documents relevant tools.
- `unlocks` names tools hidden until the skill activates.

The loader reports invalid frontmatter as diagnostics without breaking the
rest of the catalog. `skill.list` returns metadata, `skill.get` returns the
body for activation, `skill.setDisabled` changes the Personal toggle, and the
create/import/delete tools accept a `personal`, `project`, or `team`
destination. There is no skill-source registry or source-management API; Team
sync belongs to the single Team connection.

Activated and composer-selected skills retain their origin and editor path.
Chat renders the origin and can open the same `SKILL.md`.

## Agent-authored Personal skills

Mim can create and maintain a Personal skill from Chat when an active skill
explicitly unlocks the mutation tools:

- `skill_create` writes one complete `SKILL.md` under
  `~/.mim/skills/<name>/`. Its AI surface is Personal-only and does not expose
  arbitrary supporting-file writes.
- `skill.get` includes a SHA-256 `revision` for Personal skills.
- `skill_update` replaces that Personal `SKILL.md` only when
  `expectedRevision` still matches. The replacement is validated and written
  atomically; stale revisions fail so the agent must reload and reconcile.
- `skill.update` cannot mutate Mim, Team, Project, or app-provided skills.

The connected `mim` Team's `build-email-voice` skill uses this path to distill a
bounded sample of sent Gmail into one Personal `email-voice` skill. It stores
guidance, not a mail corpus, never sends email, and requires the generated
skill to evaluate every relevant drafting interaction for durable learning.
Weak, one-off, recipient-specific, or ambiguous evidence produces no update.

## Instructions

Instructions use the same origin vocabulary. The prompt composes them from
least to most specific:

1. Mim's built-in runtime instructions.
2. Team `instructions.md`.
3. Personal `~/.mim/instructions.md`.
4. Project `AGENTS.md`.

Settings shows document links instead of an embedded instructions textarea.
Personal instructions live under General and Project instructions under
Project. Personal and Mim instructions use
`.mim/origins/you/instructions.md` and `.mim/origins/mim/instructions.md`;
Team and Project use their natural paths.

## Implementation map

- `src/main/skills.ts` — scan, validation, precedence, diagnostics.
- `src/main/ai/instructions.ts` — instruction composition and managed editor
  documents.
- `src/main/ai/systemPrompt.ts` — prompt assembly and compact skill catalog.
- `src/main/tools/skills.ts` — skill/instruction tools and destinations.
- `src/renderer/components/settings/SkillsSettingsPanel.vue` — flat catalog.
- `src/renderer/components/settings/GeneralSettingsPanel.vue` and
  `ProjectSettingsPanel.vue` — editor links owned by their natural scopes.
- `src/renderer/components/chat/ChatMessage.vue` and `ChatComposer.vue` — skill
  provenance and editor handoff.
