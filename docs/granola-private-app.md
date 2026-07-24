# Granola Private App

Status: private Team app maintained outside this repository.

This document records the rationale, implementation shape, operational behavior,
and verification for the private Granola app built for Mim. It is not an
official Granola integration design. It describes the current Team app and the
reasons it belongs in the private app layer rather than core Mim.

## Motivation

The main use case is giving Mim chat and AI CLI agents access to meeting
context: recent Granola notes, attendees, summaries, and transcripts. The user
often needs to ask questions such as:

```text
What did Daniel say in the last Vandage meeting?
```

or:

```text
Find the recent meeting where we discussed ReadCube and summarize the follow-ups.
```

The old Mim workspace at `~/mim` already had a Granola service, but it was a
standalone Bun HTTP process backed by its own SQLite database. It worked, but
it was operationally awkward: it needed a separate local port, a detached run
state, private Granola API assumptions, and local token-file hacks.

The new Mim app system already supports the useful shape directly:

- enabled apps can provide named tools to chat;
- named app tools are exposed to MCP clients when the desktop is running;
- app skills teach chat when to activate those tools;
- backend jobs can do background sync;
- the app can live as a private package outside the core repo.

That makes a private headless app the right abstraction. The goal is not a
visible launcher. The goal is a durable capability: agents can retrieve meeting
context on demand.

## Context

Core Mim is intentionally a runtime, not a place for user-specific integrations.
Granola is a private app whose source lives in `mim-web/packages/granola/`.
The Team source maintainer places it at `apps/granola/`, where Mim discovers it
through the normal Team app origin. Each person reviews its permissions and
activates it independently for a local Project checkout.

## Why Not Core

The Granola implementation depends on behavior that is not suitable for a core
integration:

- private Granola endpoints such as `https://api.granola.ai/v2/get-documents`;
- local Granola desktop token files;
- fallback token refresh through WorkOS;
- macOS Keychain decryption of Granola encrypted storage;
- an assumed Granola client id and client headers;
- no public Granola OAuth/API contract.

Those dependencies are acceptable for a trusted personal app. They are too
brittle and too platform-specific for core Mim.

## Source Files

Source lives in `mim-web/packages/granola/`:

```text
package.json
README.md
backend/index.mjs
backend/index.test.mjs
skills/granola/SKILL.md
```

The package is plain ESM and has no build step. In the connected checkout its
runtime source is `~/.mim/team/apps/granola/`.

## Runtime Data

The app stores its shared local cache at:

```text
~/.mim/private/granola/granola.sqlite
```

This cache is intentionally user-global rather than workspace-local. Meeting
notes are personal context, and the user wants them available from chat and CLI
agents across workspaces.

The app reads Granola token state from:

```text
~/Library/Application Support/Granola/supabase.json
~/Library/Application Support/Granola/stored-accounts.json
~/Library/Application Support/Granola/supabase.json.enc
~/Library/Application Support/Granola/storage.dek
```

Environment overrides are supported:

```text
GRANOLA_TOKEN_PATH=/path/to/supabase.json
GRANOLA_WORKOS_CLIENT_ID=client_...
GRANOLA_MIM_DB_PATH=/path/to/granola.sqlite
```

No Granola token is copied into the repo or app manifest.

## Tool Surface

The app exposes these named tools:

| Tool | Purpose |
|---|---|
| `granola.status` | Check token/cache/sync status without network access. |
| `granola.sync` | Pull latest notes from Granola into the local SQLite cache, or fetch one transcript via `transcriptId`. The only tool that uses the network. `full: true` also prunes notes deleted in Granola. |
| `granola.search` | Search cached notes by title, body, summary, attendee, and date. |
| `granola.get` | Read one cached note by Granola document id, optionally with its cached transcript. |
| `granola.transcript` | Read/query a cached note transcript; returns a sync hint when not cached. |
| `granola.people` | Search attendees and meeting counts. |

Every tool except `granola.sync` is a pure local cache read, matching the
manifest's `read`/`low` risk labels. Network access is concentrated in
`granola.sync` (`network`/`medium`) so the permission gate sees an honest
boundary.

In chat and MCP, dotted names are exposed in the AI-safe form with underscores:

```text
granola_status
granola_sync
granola_search
granola_get
granola_transcript
granola_people
```

The direct CLI form uses dotted names:

```bash
node bin/mim.mjs tool granola.search '{"q":"Vandage Daniel","limit":1}' --workspace /Users/waqr/Desktop/mim-os --json
```

## Chat And MCP Behavior

The app includes an app-bundled skill:

```text
package:granola/granola
```

The skill activates when the user asks about meetings, calls, attendees,
meeting notes, transcripts, follow-ups, or what someone said. Its intended
workflow is:

1. Start with `granola.search`.
2. Use `granola.status` and then `granola.sync` if the cache is empty or stale.
3. Use `granola.get` for the most relevant note.
4. Use `granola.transcript` only when exact discussion detail is needed. If it
   reports `transcript_not_cached`, fetch with `granola.sync`
   `{"transcriptId": "<note id>"}` and retry.
5. Use `granola.people` when the person is remembered but the meeting is not.

Mim chat can call these tools after the app is enabled. External AI CLI agents
can call them through `mim mcp` when the desktop app is running and the package
is enabled in the active workspace.

## Implementation Details

The backend is `mim-web/packages/granola/backend/index.mjs`.

It implements:

- a `sync` ephemeral backend job;
- the six named tools above, with network access confined to `granola.sync`;
- an `agentContext` contribution with note/transcript counts and last-sync info;
- token discovery compatible with the old `~/mim` Granola service;
- token refresh through Granola first, then WorkOS as fallback, with refreshed
  tokens written back to the Granola token file atomically (temp file +
  rename) so a crash cannot corrupt the desktop app's own state;
- encrypted Granola storage decryption on macOS using the `security` CLI;
- ProseMirror-to-Markdown conversion for Granola note panels;
- SQLite cache schema for notes, attendees, transcripts, and metadata;
- multi-term search so queries like `Vandage Daniel` match across title,
  summary, notes, and attendees, with LIKE wildcards escaped so query text
  matches literally;
- incremental sync that stops only when an entire page contains nothing new,
  so an updated older note is still picked up, and pruning of locally cached
  notes that no longer exist in Granola on a completed `full: true` sync.

The cache schema uses:

```text
notes(id, title, created_at, updated_at, owner_name, owner_email,
      summary_markdown, notes_markdown, calendar_start, calendar_end, synced_at)
attendees(note_id, name, email)
transcripts(note_id, text, start_time, source)
meta(key, value)
```

The backend uses Node's built-in `node:sqlite`, matching the dependency-light
pattern already used by Mim apps such as Knowledge.

## Verification

Package-level tests run inside the app directory:

```bash
node --test backend/index.test.mjs
```

The tests cover ProseMirror-to-Markdown conversion, home-path redaction, text
compaction, multi-term query filter construction with LIKE-wildcard escaping,
date-bound normalization, attendee-list splitting, and token normalization.

To smoke-test the Team app end to end, run the Operations commands below:
`granola.status` (token + cache visibility), `granola.sync` (network sync and
token refresh), `granola.search`/`granola.get` (cache reads), and
`granola.transcript` on a cached and a non-cached note (read path and sync
hint).

## Known Limitations

- This is a private app that relies on undocumented Granola behavior.
- It assumes local Granola desktop token files are present.
- Token refresh shares the refresh token with the Granola desktop app; if both
  refresh near-simultaneously, rotation races can invalidate one side's
  session. The write-back is atomic, but the race itself is inherent to
  sharing the token file.
- Encrypted token fallback is macOS-specific.
- There is no polished UI yet; the app is headless.
- Sync is manual through `granola.sync`; no scheduler has been added.
- Note pruning only happens on a `full: true` sync that reaches the last page;
  routine incremental syncs never remove deleted notes.
- Date filters compare ISO strings without timezone normalization, so
  meetings near midnight can land on the neighboring calendar day relative to
  the user's local date.
- Search is a LIKE scan, not FTS; fine at hundreds of notes, revisit if the
  cache grows to thousands with transcripts.
- `mim list-tools` does not currently show dynamic app tools because it does
  not open a workspace before listing. Direct tool calls still work.

The related repository issue is tracked in `.private/issues.md`.

## Operations

Check status:

```bash
node bin/mim.mjs tool granola.status '{}' --workspace /Users/waqr/Desktop/mim-os --json
```

Sync latest notes:

```bash
node bin/mim.mjs tool granola.sync '{"maxPages":1}' --workspace /Users/waqr/Desktop/mim-os --yes --json
```

Search:

```bash
node bin/mim.mjs tool granola.search '{"q":"Vandage Daniel","limit":5}' --workspace /Users/waqr/Desktop/mim-os --json
```

Read a note:

```bash
node bin/mim.mjs tool granola.get '{"id":"<granola-document-id>","maxChars":20000}' --workspace /Users/waqr/Desktop/mim-os --json
```

Read or query a cached transcript (local only):

```bash
node bin/mim.mjs tool granola.transcript '{"id":"<granola-document-id>","q":"follow up","limit":20}' --workspace /Users/waqr/Desktop/mim-os --json
```

Fetch a missing transcript into the cache (network):

```bash
node bin/mim.mjs tool granola.sync '{"transcriptId":"<granola-document-id>"}' --workspace /Users/waqr/Desktop/mim-os --yes --json
```

Enable in another workspace:

```bash
node bin/mim.mjs tool app.enable '{"id":"granola"}' --workspace /path/to/workspace --yes --json
```

## Future Improvements

Useful next steps, if this continues to be used:

- add a tiny settings/status UI for token status, last sync, and manual sync;
- add a scheduler or app-start sync policy;
- add better incremental transcript sync controls;
- add ranking that boosts attendee and recency matches;
- add a migration/export command from the old `~/mim/services/granola/db.sqlite`;
- consider a core integration only if Granola exposes a stable public API.
