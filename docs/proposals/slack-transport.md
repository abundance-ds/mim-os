# Slack as a First-Class Mim Conversation Transport

## Status and decision

This proposal replaces the Slack-as-routine implementation with a clean-break
conversation transport.

The product rule is deliberately small:

> Enabling Mim in a Slack channel is standing consent for members of that
> channel to use the workspace's normal Mim agent.

Slack does not introduce another permission system. There are no per-tool
grants, approvers, elevation commands, access ceilings, or per-thread authority
records. The selected Project already owns its agent, enabled tools, connected
services, and trusted apps, and uses the person's Personal model defaults.
Slack is another place to talk to that agent.

The one setup confirmation says what this means in plain language:

> Members of #channel will be able to use Mim in this workspace, including
> changing files, running commands, delegating work, and using connected
> services.

After confirmation, turns run unattended. Nothing parks in the desktop approval
queue.

## User experience

Settings > Connections exposes only:

1. Connect the Slack bot.
2. Enable Mim in a channel.

Mention mode is the default. “Respond to every message” is an optional advanced
interaction setting, not an access level.

The initial surface is:

| Channel | Responds when | Status |
|---|---|---|
| #research | Mentioned | Connected |
| #ops | Every message | Connected |

There is no channel-specific model, prompt, agent, tool picker, or approver
configuration. A Slack turn uses the workspace's default chat agent and default
model at the time the turn starts. The general agent can delegate to mounted
specialist agents through normal subagents.

The mental model is:

> If Mim is enabled in this channel, channel members can use Mim.

## Goals

- A Slack thread is one durable Mim conversation.
- Follow-up replies in an active thread do not require another mention.
- The agent has its normal useful tool surface and can delegate to subagents.
- Channel enablement is the only Slack-specific standing-consent decision.
- Every request is attributed to its Slack sender for transcript and audit.
- Incoming messages survive process crashes after acknowledgement.
- Turns in one thread stay ordered; different threads may run concurrently.
- Complete answers return to Slack without arbitrary truncation.
- Successful Slack work stays out of the active list; failures remain visible.
- Disabling a channel immediately stops new work and prevents further tool calls
  from already-running Slack turns.

## Explicit non-goals

This design does not add:

- per-tool Slack grants;
- per-user Slack roles or approvers;
- grant/revoke/access commands;
- per-thread elevation state;
- Slack-specific model or agent profiles;
- a second tool-policy UI;
- security language injected around ordinary user requests.

If an organisation wants fewer people to direct Mim, it enables Mim in a private
channel. Slack channel membership is the understandable access boundary.

Deferred product features: DMs/MPIMs, file attachments, edited-message replay,
streaming replies with `chat.update`, emoji acknowledgements, multiple bot
accounts in one project, and always-on client ownership.

## Current state

Today the Socket Mode listener resolves active routines with `trigger.slack`,
turns a message into a routine fire, and derives authority from routine
`tools`/`approval.allow`. Consequential calls can park in Mim's desktop
approval queue even though the Slack requester cannot see or resolve the card.

Current flow:

```text
Socket Mode listener
  -> routine trigger match
  -> event ledger
  -> routine run / routine session continuation
  -> routine approval branch
  -> final assistant text
  -> Slack thread reply
```

Reusable pieces are the Slack client and keychain boundary, Socket Mode
connect/reconnect/ack mechanics, bot-message filtering, metadata trace helpers,
session storage, the AI runtime, and the existing subagent scheduler.

## Target architecture

```text
Slack Socket Mode
  -> listener: parse, filter, match enabled channel
  -> durable delivery receipt + transient inbox payload
  -> acknowledge Slack envelope
  -> per-thread serial queue
  -> thread <-> Mim session
  -> workspace default AgentProfile
  -> normal AI tool surface + trusted Slack context
  -> gate: universal invariants, then standing channel consent
  -> optional subagents with inherited Slack origin
  -> complete reply split into ordered thread messages
```

Slack remains a main-process transport. The model never chooses the outbound
channel or thread: replies are pinned to the accepted event's channel and
`thread_ts`.

## Workspace-local state

All state is machine-local and gitignored under `.mim/slack/`. Tokens remain in
the OS keychain.

### Enabled channels

`.mim/slack/channels.json`:

```jsonc
{
  "version": 1,
  "account": "bot",
  "channels": {
    "C0123456789": {
      "channelId": "C0123456789",
      "mode": "mention",
      "enabled": true,
      "createdAt": "2026-07-14T12:00:00.000Z",
      "updatedAt": "2026-07-14T12:00:00.000Z"
    }
  }
}
```

The store validates atomically and refuses duplicate or malformed channel
entries. Channel display names are runtime/cache data, not identity.

### Thread routing

Introduce `threadSessionsV2.ts` alongside the old store until cutover:

```jsonc
{
  "version": 2,
  "threads": {
    "bot:T012:C012:1720958400.000000": {
      "account": "bot",
      "teamId": "T012",
      "channelId": "C012",
      "threadTs": "1720958400.000000",
      "sessionId": "session_...",
      "createdAt": "...",
      "updatedAt": "...",
      "lastEventId": "Ev..."
    }
  }
}
```

The store supports get, upsert, delete-by-session, and bounded pruning. A stale
record pointing to a missing session heals by creating a new session.

### Durable delivery

Socket Mode must be acknowledged quickly, but an acknowledged request must not
vanish on a crash.

- `deliveries.json` stores metadata-only receipt state keyed by Slack
  `event_id`: received, queued, running, replied, ignored, or error.
- `inbox/<event_id>.json` transiently stores the accepted message text and
  routing metadata.
- The inbox payload is written atomically before acknowledgement.
- The queue moves the message into its session transcript, tagged with
  `slackEventId`, then deletes the inbox payload.
- Boot replays accepted inbox entries idempotently. An event already present in
  the transcript or marked replied is never run twice.
- Metadata receipts are bounded. Orphaned payloads are pruned only after their
  transcript copy or terminal failure is confirmed.

Slack transcripts then follow normal Mim session storage, search, history, and
local-audit settings. There is no special Slack-only retention policy.

### Session metadata

`Session` and the session manifest gain:

```ts
slack?: {
  account: string
  teamId: string
  channelId: string
  threadTs: string
  status: 'queued' | 'working' | 'done' | 'error'
  lastEventId: string
  lastRequesterId?: string
  lastRequesterName?: string
  startedAt?: string
  completedAt?: string
  error?: string
}
```

Per-message metadata remains the source of truth for the sender of each turn.

## Standing channel consent

`ToolContext` gains trusted main-process metadata:

```ts
slack?: {
  account: string
  teamId: string
  channelId: string
  threadTs: string
  requesterId: string
  requesterName?: string
}
```

This context is constructed from the Socket Mode envelope and channel store. It
is never accepted from model-authored input.

Gate order:

1. Existing universal invariants still run first: readonly resource guarantees,
   trust acknowledgements, and user-only PTY agent controls.
2. For `actor: 'ai'` with `ctx.slack`, resolve the current channel record.
3. Enabled channel: allow and emit an attributed `gate.decision` with reason
   `trusted Slack channel`.
4. Missing/disabled channel: deny immediately. Never call
   `sendApprovalRequest`; never create a pending approval.
5. Desktop approval mode and session “always allow” are irrelevant to Slack
   turns because channel enablement is the standing consent.

The transport uses the ordinary default chat profile. Tool visibility comes
from that profile and the existing workspace Settings > Tools policy. Slack
does not intersect, widen, or reinterpret it.

This is deliberately powerful. Granting `shell.run` through the ordinary
workspace tool surface means full shell authority; the transport does not claim
to sandbox it.

## Identity and prompt contract

Slack user IDs are attribution, not another authorization layer. Resolve display
names through a small cached `users.info` call; failure falls back to the user
ID and never blocks a turn.

The user message remains an ordinary user instruction. Trusted system context
adds only accurate transport information:

```text
You are responding in Slack channel #research.
Requester: Jane (U024BE7LH).
Reply normally and carry out the request using your available Mim capabilities.
Your final response will be posted back to this thread.
```

Do not label the human request “not instructions.” Retrieved pages, quoted
content, and tool output retain their ordinary lower-trust status, while the
authenticated Slack message is the task request.

Tool spans and gate decisions carry:

- `principal: "slack:U..."`
- `callerName`
- `transport: "slack-socket"`
- session, channel, and thread identifiers

## Turn lifecycle

1. Parse the envelope; ignore bot/self messages and unsupported message
   subtypes. Deduplicate `app_mention`/message double delivery.
2. Match an enabled channel. Mention mode accepts a bot mention or a follow-up
   in a known thread; always mode accepts ordinary channel messages.
3. Persist the delivery receipt and inbox payload, then acknowledge Slack.
4. Enqueue by `account/team/channel/threadTs`. Commands and conversation turns
   do not have separate paths because there are no Slack control commands.
5. Resolve or create the thread session. Mark it unarchived and working; append
   the requester message idempotently.
6. Run `streamProfileResponse` with the workspace default chat profile/model
   and trusted Slack context. Drain the stream in main.
7. Post the complete final assistant text to the pinned thread. Split long text
   into ordered, Unicode-safe chunks near 3,500 characters, preferring paragraph
   boundaries and preserving Markdown code fences. Never silently truncate.
8. Mark the receipt replied, session done, and session archived.
9. On failure, retain the user message, mark the receipt/session error, leave the
   session active, and post a short safe error with a trace reference. Do not
   expose raw exception text or post a second error after a successful reply.

Different threads use a bounded shared concurrency pool. Queue limits and
shutdown behavior protect the process, not the agent's reasoning ability.

Workspace switching first stops acceptance, aborts in-flight Slack turns, drains
or persists queued deliveries, and disposes the old transport before changing
the registry workspace path.

## Subagents

Slack-origin subagents inherit the same `ctx.slack` origin and revalidate that
the channel remains enabled on every tool call. They receive the parent tool
surface normally; there is no separate grant mechanism.

The default agent's system context exposes the mounted-agent catalog so it can
choose specialists by capability. Specialist routing is an agent decision, not
a channel setting.

Long-running delegation must not require a model to poll for hours:

- If the parent waits for a child, completion follows the normal turn.
- If the parent returns while a child remains active, the child retains the
  Slack root session and reply route.
- An uncollected terminal child event enqueues one internal continuation on the
  same thread. The parent agent receives the result and decides what to report.
- Collected results and already-notified completions never produce duplicate
  Slack replies.
- Disabling the channel prevents the continuation and leaves the result visible
  in Mim Activity.

## Desktop behavior

- Add `RunKind: 'slack'`.
- Working and failed Slack sessions appear in Activity; successful sessions
  auto-archive into History.
- Main broadcasts a Slack session-change event so the renderer refreshes
  background work live.
- Opening a Slack session shows the ordinary transcript and requester names.
- The desktop composer is disabled for Slack-owned sessions with the message
  “This conversation continues in Slack.” There is no ambiguous local/remote
  concurrent turn path.
- Deleting a Slack session removes its thread mapping; a future thread message
  starts a fresh session.

Settings > Connections gets the minimal enabled-channel list and one
`MimDialog` channel picker. It uses Tailwind utilities and the existing
`MimSelect` primitive.

## Tool and API changes

Keep credential tools:

- `slack.bot.connect`
- `slack.bot.disconnect`
- `slack.bot.status`
- `slack.listener.status`

Replace routine setup with:

- `slack.bot.channels` — list enabled channels and readiness;
- `slack.bot.enableChannel` — enable/update one channel after the one-time
  standing-consent confirmation;
- `slack.bot.disableChannel` — disable/remove one channel;
- `slack.bot.check` — credentials, channel configuration, and live listener
  readiness.

The desktop AI and MCP aliases may orchestrate connect + enable, but credential
storage and channel enablement remain separate registry operations with their
existing secret/config audit behavior.

## Clean-break cutover

Delete:

- `trigger.slack`, Slack routine types/normalization/diagnostics, and routine
  continuation code used only by Slack;
- the capability-group-to-routine pipeline in Slack setup;
- listener callbacks for run/start/continue routine;
- Slack trigger controls and labels in the routine renderer;
- v1 thread routing after the listener cutover is complete.

Rework:

- `listener.ts` around enabled channels and durable deliveries;
- `tools.ts` around connect + enable-channel setup;
- `index.ts` wiring and workspace/shutdown ordering;
- `aiRuntime.ts` to carry Slack context through all AI tool calls and
  subagents;
- `gate.ts` with the small standing-channel branch;
- sessions/manifest/runs for Slack metadata and live events;
- server MCP specs and desktop AI management aliases;
- Settings > Connections;
- current-state docs and manual.

Keep:

- Slack client/keychain boundary;
- Socket Mode lifecycle and rate-limit retry;
- normal workspace tool policy;
- normal default AgentProfile/model resolution;
- ordinary session compaction, search, trace, and history behavior.

## TDD matrix

Tests are co-located and mock only Slack HTTP/socket, keychain, and model-provider
boundaries.

| Area | Required contracts |
|---|---|
| Channel store | atomic CRUD, malformed-state diagnostics, mention/always mode, enable/disable, workspace isolation |
| Gate | enabled channel allows without pending approval; disabled channel denies; developer/strict mode irrelevant; universal hard invariants still win; attributed audit |
| Delivery | payload durable before ack; receipt dedupe; crash replay; transcript idempotency; bounded cleanup; Slack text absent from metadata receipt |
| Thread store v2 | key shape, session healing, delete-by-session, pruning, v1 ignored at cutover |
| Listener | bot/subtype filtering, mention/always/known-thread matching, double-delivery dedupe, ack ordering, reconnect, refresh after channel changes |
| Transport | new/follow-up session, ordered rapid messages, requester metadata, default model/profile, full reply chunking, reply pinning, success archive, safe failure, workspace-switch abort |
| Subagents | mounted-agent catalog available to the root; inherited Slack origin; no approval parking; disabled-channel denial; waited completion; asynchronous completion continuation; no duplicate notification |
| Tools | connect remains separate; enable/disable/list/check; listener refresh; no routine file written |
| Sessions/search | Slack metadata/manifest round-trip, failed input retained, ordinary search/retention behavior, boot reconciliation |
| Renderer | Slack RunKind/status, live refresh, archived History row, transcript requester label, composer disabled, minimal channel dialog |
| Routine removal | `trigger.slack` becomes an invalid-trigger diagnostic and Slack controls disappear |

## Phased implementation

Every phase lands with `npm run test` green.

1. **Foundations, additive.** Add the channel store, trusted Slack context,
   session/manifest metadata, gate branch, delivery store, and
   `threadSessionsV2.ts`. The current listener continues using its untouched v1
   store.
2. **Transport, side-by-side.** Implement the serial queue, durable acceptance,
   session runner, reply chunking, identity cache, workspace-scoped lifecycle,
   and Slack-origin subagent propagation behind tests. Nothing is wired to the
   live listener yet.
3. **Atomic vertical cutover.** Rewrite the listener and index wiring; add channel
   tools and minimal Settings UI; add Slack run/session events; remove Slack
   routine backend and renderer support in the same change; update MCP/AI
   management aliases and current-state docs.
4. **AI-native follow-through and hardening.** Add asynchronous subagent
   completion continuations, crash replay/reconciliation, queue pressure tests,
   reply partial-failure handling, manual real-Slack verification, and final
   documentation/manual polish.

Run `npm run test:team:compat` with `MIM_TEAM_PATH` after phases 3 and 4 because AI runtime and
named-tool context propagation are shared with external apps.

## Verification

- `npm run test` after every phase.
- `npm run test:team:compat` with the relevant Team after the cutover and final phase.
- `npm run docs:gen && npm run docs:lint` after current-state docs change.
- Manual test with a real Slack app:
  1. connect credentials;
  2. enable one private test channel in mention mode;
  3. mention Mim and verify a threaded response plus archived History session;
  4. request file work and a delegated task without any approval card;
  5. send two rapid follow-ups and verify ordering;
  6. verify a long answer arrives completely in multiple messages;
  7. start a long subagent, let the parent return, and verify completion resumes
     the same Slack thread;
  8. disable the channel during a running turn and verify subsequent tool calls
     stop and queued work does not run;
  9. restart after acknowledgement but before execution and verify exactly one
     recovered turn/reply;
  10. switch workspaces during a turn and verify no action reaches the new
      workspace.

## Documentation cutover

When phase 3 lands:

- rewrite the Slack section in `docs/integrations.md`;
- add `docs/slack.md` as the subsystem contract;
- update `docs/security.md` with standing channel consent and deny-not-park;
- remove Slack from `docs/routines.md`;
- update `README.md`, `docs/_MAP.md`, and `docs/gotchas.md`;
- mark `docs/proposals/slack-listener.md` superseded by this proposal;
- update the generated manual claims and user-facing Slack setup chapter.

The docs should describe the one product decision, not expose the internal
delivery machinery as user-facing permission configuration.
