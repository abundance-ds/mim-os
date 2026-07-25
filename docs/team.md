# Team

A Team is an optional company repository. It can supply shared files,
instructions, skills, apps, and routines to one Mim installation. A person who
does not connect a Team has no Team folder and loses no core functionality.

Each Team repository is authoritative only for that company. `mim-team` is
authoritative for the connected Team on the maintainer's installation; it is
not authoritative for `mim-os` or for every Mim user. Another company creates
and owns a separate repository if it wants this capability.

Connecting a Team never moves or deletes Project data. An app may read
Project-owned `issues/` or `knowledge/`, but its shared code remains in the
Team repository.

## User journey

To connect:

1. Open **Settings > Team**.
2. Paste the credential-free link supplied by the company.
3. Select **Connect Team**.
4. Confirm the Team says **Up to date**.

Mim checks quietly. The normal states are:

- **Up to date** — the installed Team release is current.
- **Update available** — Mim lists recognizable apps, skills, routines, files,
  and guidance that changed.
- **Updating** — the chosen release is being installed as one Git revision.
- **Updated** — the release is installed.
- **Needs attention** — Mim preserved a conflict or found invalid content.

There is no manual collaboration-sync control in the Team UI. Repository and
folder information lives under **Developer details**. When an update is
available, the only primary action is **Update**.

Team apps become available but do not silently run. Each person reviews and
enables apps per Project. If an updated app requests additional access, the
release summary flags it and the existing app grant no longer authorizes the
expanded access. Permission reductions do not require a second review.

## Repository contract

```text
team.yaml             # required Team identity
team-index.json        # required generated release index
instructions.md       # optional guidance for every Project
files/                # optional shared, writable files
skills/<name>/
  SKILL.md             # version required in frontmatter
apps/<id>/
  package.json         # version required
routines/              # optional shared routine definitions
```

`team.yaml` contains a non-empty name:

```yaml
name: My Team
```

Contribution directories must be real directories, not symlinks. An absent
optional directory contributes nothing. Skill names and app ids match their
folder names.

`team-index.json` is the release boundary. It records the Team identity,
released app and skill versions, content digests, executable app surfaces, app
permissions, and the shared routine/file/instruction set. Before changing the
installed checkout, Mim opens the remote revision separately and verifies that
the complete content matches the index.

## Team repository workflow

The Team repository owns its apps and skills. It does not promote them from a
global primary-app repository.

Its GitHub workflow:

1. validates the fixed Team contract;
2. runs every Team and app test;
3. verifies indexed Team apps against the current Mim runtime;
4. rejects version regressions;
5. patch-bumps changed app or skill content when the contributor did not
   provide a higher version;
6. writes one deterministic `team-index.json`;
7. commits the versions and index only after all checks pass.

Pull requests validate without publishing. The generated release commit makes
one remote Git revision the complete update.

## Runtime ownership

The Personal connection lives in `~/.mim/config.yaml`:

```yaml
team:
  repository: https://github.com/organisation/team.git
```

The checkout lives at `~/.mim/team/`. Each Project receives a managed
`.mim/team` link to that checkout. Only `files/` appears as an extra Files
root; the other contribution kinds are loaded through their normal systems.

Mim accepts credential-free HTTPS, SSH, and local Git repository locations.
It uses system Git, including the person's normal credential helper or SSH
keys, and never stores a separate Team token. Git LFS is required only when
the repository attributes request it.

## Update engine and tools

`src/main/team/teamSource.ts` owns the connection and Git checkout.
`teamRelease.ts` parses and compares releases; `teamReleaseContents.ts`
rebuilds and verifies content digests and access declarations. `teamFiles.ts`
manages the safe Project mount. `liveTeamRefresh.ts` refreshes apps, tools,
routines, and mounted files after connection or an accepted update.

The tool surface is:

- `team.status` — read installed state without network access;
- `team.connect` — clone and validate one Team;
- `team.open` — resolve its validated paths;
- `team.check` — fetch metadata and report an available update without
  changing installed content;
- `team.update` — validate and install the selected Team release.

Local edits made to the writable Team checkout are committed and published in
the background when possible. Remote content is never applied by that
background publishing path. Mim checks for a remote release on open,
periodically while running, and when Team settings opens, then waits for the
person to choose **Update**.

Offline checks leave the installed Team working. If local and remote edits
conflict, Mim preserves `conflict-local` and `conflict-remote` sibling copies
and stops. A person keeps the intended content in the Team folder and tries
the update again; Mim never silently chooses a version.

## Content precedence

| Team content | Where it appears | Activation |
| --- | --- | --- |
| `files/` | Files under the Team name | Always available |
| `instructions.md` | Every chat after Mim instructions | Automatic |
| `skills/` | Settings > Skills and Chat | Each person may disable |
| `apps/` | Settings > Apps & agents | Review and enable per Project |
| `routines/` | Routines | Review and activate per machine |

Project apps override Team apps with the same id; Team apps override Mim apps.
Project skills override Personal skills, which override Team skills, which
override Mim skills.

## Troubleshooting

**Mim cannot connect.** Run `git ls-remote <repository>` with the same link and
fix the system Git credentials until it succeeds.

**No Team app appears.** Confirm the Team says **Up to date**, then select
**Refresh apps** in Settings > Apps & agents. Apps must be direct children of
`apps/` with a valid manifest and an entry in `team-index.json`.

**An app has no launcher.** Enable it in Settings > Apps & agents. A headless
app has no launcher even when enabled.

**An update needs attention.** Open **Developer details**, open the Team folder,
and resolve the preserved copies explicitly before trying again.
