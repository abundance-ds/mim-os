---
id: security
title: security
order: 7
sources:
  - docs/security.md
  - src/main/security/gate.ts
verified: bf1358ebd68b1348a9fd85c6576c5b71e5f11880
---

# security

The permission gate is a speed-bump on AI and app automation so a user can catch an unintended or destructive action before it runs. `gate.check(tool, params, ctx)` runs before every `tool.execute` in the registry. A denied check throws `PermissionDeniedError` and the tool body never runs.

## Actors

The actor on the tool context is the trust boundary:

::: rows
- `user` / `system` -- always allowed, never prompted. Renderer IPC hardcodes `actor: "user"` -- the renderer cannot claim AI or app identity.
- `ai` -- the only actor the interactive gate ever prompts. AI tool calls originate in the main process from the AI runtime, not via renderer IPC.
- `package` -- checked against declared manifest permissions only. Pass means allowed silently; fail means denied. Apps never get an interactive prompt.
:::

## Approval modes

The Personal `automationApprovalMode` preference in `~/.mim/config.yaml`
controls prompting behavior for the `ai` actor across Projects:

::: rows
- `strict` -- every `ai` action prompts, including reads.
- `normal` (default) -- prompts when the tool's effect is `mutate` or `external`.
- `developer` (UI label "Allow all") -- bypassed before any check; prompts nothing.
:::

## Effect classification

Effect is the prompt key. `toolEffect(name)` resolves to `read`, `mutate`, or `external`:

- Categories `read`, `search`, `ai` map to effect **read** (no prompt in normal mode, prompt in strict).
- Category `network` maps to effect **external** (prompts in normal and strict).
- All other categories (`write`, `secrets`, `system`, `settings`, `ui`, `general`) and any unmapped tool map to effect **mutate** (prompts in normal and strict).

Static `EFFECT_OVERRIDES` reclassify specific tools. For example, `workspace.orient` and `log.append` are overridden to `read` because they are benign internal writes. `editor.open` and `workbench.open*` are overridden to `read` because they are navigation, not mutation.

`risk` (low, medium, high) no longer gates anything. It sets the inline approval card's visual caution level.

## Path classification

`classifyPermissionPath` in `gate-paths.ts` classifies every path-bearing parameter:

::: rows
- `workspace` -- inside the workspace. Normal approval rules apply.
- `team` -- inside the managed `.mim/team/` checkout. Contributions are writable under normal rules; mutation of the checkout mount itself is denied.
- `sensitive` -- credential and config locations. Always prompts in strict and normal, even when a session "always allow" is active.
- `outside-workspace` -- outside the workspace root. Same floor behavior as sensitive.
- `invalid` -- no path or empty. Denied.
:::

Sensitive locations include `.ssh`, `.gnupg`, `.aws`, `.config/gcloud`, `.kube`, `.docker`, `.npmrc`, `.pypirc`, `/etc`, `/private/etc`, `/var/run`, `/Library/Keychains`. Sensitive segments include `credentials`, `secrets`, `.netrc`, `.bashrc`, `.zshrc`, `.profile`, `.bash_profile`, `.bash_history`, `.zsh_history`. The prefix `.env` matches `.env`, `.env.production`, `.env.local` but not `envelope.md`. SSH key patterns (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` and `.pub` counterparts) are also classified as sensitive.

## Path floor

A `sensitive` or `outside-workspace` path always prompts under strict and normal modes, regardless of effect. The floor is checked before session "always allow" so it can never be suppressed. Developer mode bypasses it.

## Session always allow

The session-scoped "always allow" checkbox sets a per-tool allow for the active session. It is subject to the path floor: sensitive and outside-workspace paths still prompt. Cleared when the session is cancelled.

## App permissions

The `package` actor is checked against the manifest `permissions` block. If the app has not declared the required permission, the call is denied without prompting. Team and Project apps with executable backend or terminal UI code, or effective permissions, also require a per-machine acknowledgement recorded in `.mim/packages/enabled.json`. Terminal interfaces call tools as the `package` actor and remain inside the same manifest boundary as iframe app views. `app.trust` is hard-denied to the `ai` actor before any allow path.

Apps cannot call `agent.*` tools, app-management tools, trust tools, account tools, or terminal tools.

## Hard denials

Two tool calls are hard-denied to the `ai` actor before any approval flow or developer-mode bypass: `app.trust` (trust acknowledgement is user-only) and `agent.launch`/`agent.stop` (agent sessions carry the user's full shell authority).

## Audit

Every gate decision (allowed, denied, requested, approved, bypassed) is recorded as a `gate.decision` trace event in the unified trace stream at `.mim/traces/`. Params are redacted before recording. Approval requests sent to the renderer carry redacted params plus an un-redacted preview of file content so the user can review the change.
