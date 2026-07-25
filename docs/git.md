# Git

Mim uses git in four separate places:

- `src/main/git.ts` for project clone and resource mirror helpers;
- `src/main/tools/git.ts` for user/agent-facing workspace git tools;
- `src/main/tools/sync.ts` for the managed-sync workflow;
- `src/main/team/teamSource.ts` for the one writable Team checkout.

## Clone Helpers

Clone operations route through `src/main/git.ts`. It prefers the system `git`
binary for full SSH, credential helper, and platform behavior. If no `git` is on
PATH, clone falls back to bundled isomorphic-git for HTTPS repositories.

Fallback caveat: isomorphic-git is HTTPS-only. SSH URLs (`git@host:...`,
`ssh://`) require system git; without it, `cloneRepo` throws a friendly error
pointing the user to the HTTPS URL.

The Clone Repository flow in `AddProjectDialog.vue` uses this path. Shared
resource git mirrors also use the helper layer.

## Team Git

The Personal Team connection is a credential-free repository location in
`~/.mim/config.yaml`; its checkout is `~/.mim/team/`. Team clone, status, open,
check, publish, and update all route through the resolver described in
[team.md](team.md).

Unlike the legacy pull-only resource mirrors, Team Git requires the system
`git` binary. Credential-free HTTPS, SSH, and local repository locations are
accepted. HTTPS uses the normal system credential helper; SSH uses normal
system keys and configuration. Mim never accepts credentials in a repository
URL or stores a separate Team token.

Git LFS is checked only when a Team repository's `.gitattributes` files request
`filter=lfs`. Cloning defers LFS smudging, reports a platform-specific install
action if the capability is missing, and runs `git lfs pull` when available.

Mim publishes writable local Team changes in the background. It fetches remote
metadata but does not apply remote content automatically. A validated
`team-index.json` lets Mim show one release summary; the person chooses
**Update** to install the full remote revision.

If both sides edit the same path, Mim captures the local and remote Git stages,
aborts the rebase, restores the local working file, and writes
`*.conflict-local-*` and `*.conflict-remote-*` sibling copies. Updating stops
until the person keeps the desired content and tries again.
Neither version is silently selected or discarded.

## Workspace Git Tools

`src/main/tools/git.ts` exposes the current workspace repository through the
tool registry:

- `git.status`
- `git.diff`
- `git.log`
- `git.commit`
- `git.pull`
- `git.push`

These tools intentionally use the system `git` binary only. Agent-visible repo
operations should match the user's normal local git environment, including SSH
keys and credential helpers. If system git is unavailable, the tools return a
normal tool error instead of attempting a partial fallback.

Permission policy:

- status, diff, and log are read tools;
- commit is a workspace mutation;
- pull and push are network operations;
- packages cannot call `git.*`.

The central AI runtime wraps these as explicit agent tools, so an agent can
inspect repo state, show a diff, and commit only through the approval gate.

## Managed Sync

`src/main/tools/sync.ts` exposes:

- `sync.status`
- `sync.configure`
- `sync.now`

Workspace sync is opt-in and configured in committed `mim.yaml`:

```yaml
sync:
  mode: managed
  remote: git@github.com:org/repo.git
```

`mode: manual` is the default. Existing git repositories are not silently moved
into managed sync. `sync.status` reports manual vs managed mode, git presence,
remote, dirty state, ahead/behind counts, and conflict state.

`sync.configure` can switch modes and, for managed mode, initialize git and set
the `origin` remote when provided. Managed sync stages current changes, creates
a "Mim sync" commit when needed, pulls with rebase when an upstream or matching
remote branch exists, and pushes. First pushes set the upstream branch. The
same workflow runs on Project open, after successful filesystem mutations, and
before quit. `sync.now` remains the explicit retry and manual escape hatch.

Network failures produce a plain-language paused state and retry in the
background. Non-retryable errors stop automatic sync. Same-file conflicts use
the same sibling-copy preservation as Team updates and require an explicit retry.
The stop record is machine-local under `.mim/`.

Managed configuration and every managed sync reassert `.mim/` in the workspace
`.gitignore` before staging. This protects transcripts, traces, activation, and
other machine-local runtime state even when managed sync was enabled on a
workspace that did not pass through the normal scaffold.

Settings > Project is the human manage surface for sync mode, remote, status,
guided platform-specific Git/Git LFS setup, and **Sync now**. Git LFS is checked
only when the Project attributes request `filter=lfs`; normal binary files do
not require it.

## Fetched-change awareness

`awareness.recent` reads local Project and mounted Team Git history without
contacting a remote. The Files **Changed** view uses it after background sync to
show the latest fetched change for each current file, including author, commit
time, and commit summary. A two-client contract test verifies that one client's
fetched commit appears with the other client's author identity.

This first awareness cut is deliberately durable and offline-capable. Mim does
not ship live open-file presence, locks, shared editor state, or an online relay.
