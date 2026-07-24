# Routines

Status: proposal for hosted scheduling/trigger phases. Store, validation,
manual runner, activation, session metadata, Navigator classification,
routine-aware permission gating, trigger schema validation, and pure
interval/file/webhook automation helpers are implemented; see
[routines.md](../routines.md) for current behavior.

A **Routine** is a standing instruction the workspace can run later — on
request, on a schedule, when a file lands, when a webhook arrives, or when
another run finishes. Each firing creates a **Run**: a real, headless chat
turn by a real agent, gated, traced, and visible as ordinary Mim work.
Routines are workspace files, so a team's automation is versioned, reviewed,
and shared through git exactly like its prose and its code.

The bet behind this proposal: the future of AI agents is long-running,
scheduled, and externally triggered processes, not just foreground chat. Mim
needs this as a deeply integrated core capability — one subsystem that can
trigger anything Mim can do — not a bolt-on cron.

The product line is deliberately narrow:

- **Skill** — reusable agent knowledge loaded when a task calls for it.
- **App job** — app-owned imperative background code.
- **Routine** — workspace-owned standing prompt that starts a normal Mim run.

If routines stop being "saved prompts that run themselves" and become a DAG
engine, notification system, or app-extension format, they start muddying the
app instead of clarifying it.

## Context

What exists today, and why none of it is this:

- **The agent loop is already renderer-free.** `streamProfileResponse`
  (`src/main/ai/aiRuntime.ts`) runs the full tool loop in the main process
  against an `AgentProfile` — instructions assembly, tool visibility,
  step cap, session persistence in `onFinish`. The renderer only streams the
  result. A routine run is this exact code path with no one watching.
- **`AgentProfile` is a mounted primitive.** `src/main/ai/agentMounts.ts`
  resolves app `agents` exports into profiles with tool visibility
  intersection, template-var resolution, and per-turn skill pre-activation
  (agents-as-apps, implemented). Routines reuse this
  wholesale: a routine either names a mounted agent or runs the default chat
  profile under its own visible-tool filter.
- **Package jobs are the imperative cousin, not the answer.**
  `src/main/packages/packageJobs.ts` runs app-defined JavaScript with a status
  model, persistence under `.mim/packages/<id>/runs/`, and boot-time
  `reconcileStaleRuns`. Jobs are code an app author wrote; they cannot be
  authored in prose, they belong to one app, and nothing ever starts one
  except a user or an agent doing it right now. Routines are declarative,
  prose-first, workspace-owned, and self-starting. The job runner's
  discipline (terminal statuses, stale-run reconciliation, run-id-as-trace-id)
  is the pattern to copy, not the system to extend.
- **Nothing in Mim schedules anything.** The only recurring timers in
  `src/main` are the four-hourly app-update check (`index.ts`) and the
  telemetry flush. There is no cron, no recurrence, no trigger registry.
- **The runs store has the new kind.** `src/renderer/stores/runs.ts`
  aggregates chat, routine, package-job, and agent-session runs into Navigator
  rows. The dead `'workflow'` `RunKind` has been removed. `needs-approval` is
  an existing run status.
- **The gate assumes someone is watching.** `src/main/security/gate.ts`
  resolves AI-actor prompts through `sendApprovalRequest`; the headless kernel
  (`headless.ts`) defaults approvals to **deny** — safe, but it means an
  unattended agent today either runs with everything pre-allowed or fails on
  first mutation. Neither is acceptable for routines; §Permissions is the
  heart of this proposal.
- **The definition format has a proven ancestor.** Skills are folders with a
  `SKILL.md` — YAML frontmatter plus a markdown body, loaded from the
  workspace with precedence and diagnostics (`src/main/skills.ts`,
  [skills.md](../skills.md)). Routine files mirror this shape.
- **Trigger raw material exists.** The workspace file watcher
  (`src/main/workspace/workspaceFileWatcher.ts`) watches individually
  registered open files — directory-pattern watching is new but small. The
  local Express server (`src/main/server/server.ts`) is where webhook routes
  land. The trace stream ([observability.md](../observability.md)) carries
  terminal trace events — the chaining source — and gives routines audit,
  cost tracking, and Review presence for free.

## Motivation

Mim is the operating system for AI-native research organisations. Research
work has a pulse, and today Mim only beats when a human clicks:

- **Nightly literature sweep.** Scholar-style searches over the standing
  research questions, new findings triaged into the knowledge graph, a digest
  waiting as a run in the morning.
- **Morning issue triage.** Read the board, close what yesterday's commits
  resolved, flag what went stale, draft the standup note into the logbook.
- **Data-drop processing.** A collaborator drops a CSV into `inbox/`; the
  routine validates the schema, runs the QC script through `code.run`, files
  an issue if checks fail, moves the file into `data/` if they pass.
- **Report drift checks.** Weekly: re-run the analysis, diff the numbers
  against the manuscript's claims, comment on the document where they
  diverge.
- **External events.** A registry webhook fires when a trial record updates;
  a Slack message lands in the intake channel; the pipeline finishes upstream.

None of this needs new integrations. Everything in Mim is a tool behind one
registry — files, `code.run`, git, `issues.*`, `knowledge.*`, Slack, web
search, `chat.send`, app jobs — so a routine that runs a headless chat turn
inherits the entire surface with zero per-integration work, and inherits
trace, audit, run rows, and completion pings the same way. "Trigger anything"
is true by construction, not by roadmap.

The differentiator is where routines live. Hermes keeps cron jobs in
`~/.hermes/cron/jobs.json` — personal, invisible, unversioned. Claude Code's
Routines live cloud-side. Mim's routines are **files in the workspace**:
`routines/nightly-lit-sweep.md` is diffed in code review, arrives with
`git clone`, and is part of the team's contract about how the project runs.
When a new postdoc joins, the lab's automation is already in their checkout.
That is what local-first, file-based buys here, and it should carry the
motivation section of everything we say about this feature.

## The Routine

### Definition format

A routine is a markdown file in `routines/` at the workspace root (sibling of
`skills/`): frontmatter declares when and under what authority; the body is
the prompt.

```markdown
---
name: nightly-lit-sweep
description: Sweep new literature on the standing questions and file findings.
trigger:
  schedule: "0 5 * * *"        # cron, local time; or `every: 4h`
agent: package:scholar/sweeper  # optional; default is the core chat agent
model: claude-opus-4-8          # optional default, same semantics as agents
tools: [web.search, web.read, knowledge.search, knowledge.create, fs.write]
approval:
  allow: [web.search, web.read, knowledge.search, knowledge.create, fs.write]
steps: 200                      # optional step cap; default matches chat
missed: once                    # skip (default) | once
---

Search for new publications relevant to the questions in
`research-questions.md`. For each genuinely new finding, create a knowledge
entry with the citation. Write a short digest to `reports/lit/{{DATE}}.md`.
```

- One trigger per routine (manual run-now is always available). A pipeline is
  routines chained with `trigger: after`, not a multi-trigger routine.
- The body passes through the same template-var resolution as `AGENTS.md` and
  agent instructions (`resolveTemplateVars`), so `{{WORKSPACE_TREE}}`,
  `{{PROJECT_LOG}}`, and friends compose. Trigger payloads add trigger-scoped
  variables (§Triggers).
- `tools` controls the visible tool surface. It uses canonical registry ids
  with the same load-time diagnostics as agent mounts: unknown ids are
  diagnostics, not silent no-ops. Omit `tools` to expose the normal chat tool
  surface.
- `approval.allow` controls unattended grants. It is a separate list on
  purpose: a tool may be visible without being pre-approved, in which case a
  consequential call parks for human approval. When `tools` is present,
  `approval.allow` must be a subset of it.
- No `approval.allow` means no standing grants. The routine can still make
  ordinary read/search calls under the routine baseline, but mutate,
  external, system, settings, and secrets calls park unless explicitly
  granted.
- No secret ever appears in a routine file — the file is git-shared by
  design. Webhook secrets are named references resolved from the keychain
  (§Triggers).

Definition and machine state are strictly split: the definition lives in git;
`nextRunAt`, last-run ids, heartbeat, lock, scheduler ownership, and
per-machine activation live under `.mim/routines/` (gitignored). A `git pull`
can change what a routine *is*; it can never change what your machine has
*agreed to run* (§Activation and trust).

### Naming

Judged against [ontology.md](../ontology.md) (draft, so this is alignment,
not enforcement):

- **Routine → Run.** The standing definition is a Routine; each firing is a
  Run — the existing kernel umbrella for tracked work. No new execution noun.
- **The funeral (law 4):** the dead `'workflow'` `RunKind` in
  `src/renderer/stores/runs.ts` is retired and replaced by `'routine'`.
  "Workflow" is already on the banned list; this proposal buries it.
- **The Dr. R test (law 5):** "A routine is a standing instruction Mim
  carries out on its own — on a schedule or when something happens." No
  implementation words needed.
- Rejected names: *cron job* and *schedule* name the trigger, not the thing;
  *task* collides with everyday usage; *automation* is a category, not a
  noun; *job* is taken (second-tier: background work inside an app run).
  "Routine" also has industry momentum — Claude Code shipped the same concept
  under the same name — which lowers the explanation tax.

## Architecture

New code lives in `src/main/routines/` (store, ticker, runner, triggers) plus
`src/main/tools/routines.ts`. Decisions and rationale:

### Runner — a routine run is a headless chat turn

The runner resolves an `AgentProfile` — the routine's named agent via
`agentMounts.resolveProfile`, or the default chat profile — then applies the
routine's `tools` as a visibility filter on the AI tool map. The separate
`approval.allow` grant is passed to the gate in routine metadata on the tool
context; it is not an `AgentProfile.toolAllowlist`, because visible and
pre-approved are different product concepts.

The rendered body becomes the user message. Desktop UI starts create a queued
chat session with that user message already visible; the renderer then consumes
the ordinary `/api/ai/chat` stream, so assistant text, tool calls, tool results,
and approvals are live transcript state rather than hidden main-process work.
The server recognizes active routine sessions and attaches the queued prompt plus
model/agent/tools and approval grants from trusted session and routine metadata
before streaming.

Scheduler/headless runs still call `streamProfileResponse` and drain the stream
inside the main process because no renderer owns those runs. `persistSession`
stays true: the run **is** a chat session. Session storage grows explicit
routine metadata:

- `routineId` — the standing definition that fired.
- `routineRunId` — this firing's run id.
- `routineStatus` — `working`, `needs-approval`, `done`, `error`, or
  `stopped`, persisted so headless runs do not depend on renderer-only
  status state.
- `routineError`, `routineFiredAt`, `routineCompletedAt` — enough for
  History, Review, and stale-run reconciliation.

The renderer replaces the unused `'workflow'` `RunKind` with `'routine'`.
Routine rows open the ordinary chat work surface, because the transcript is
the run, but they can be titled and grouped as routines. Opening the run
shows the full transcript with inline approval cards; pings, History, cost
stats, and trace detail use the same run primitives as chats and app runs.

Trace shape follows the package-job precedent: a `routine.fired` root span
whose id is the routine run id, with the chat turn nested under it. That
requires `streamProfileResponse` to accept an optional trace parent instead
of always starting an unrelated trace. Terminal events carry duration and
status. Boot-time reconciliation marks routine sessions left in `working` or
`needs-approval` by a crash as errors, mirroring `reconcileStaleRuns`.

Concurrency: a fire that arrives while the same routine's previous run is
still active is skipped and recorded (`routine.skipped` trace event) — the
package-job non-parallel default, which is the right default for agents that
write files.

### Ticker — schedule triggers and their health

A 60-second ticker in the main process evaluates schedule triggers only on a
machine that has been explicitly enabled as a scheduler for this workspace:

- `nextRunAt` per routine is computed from the cron/interval expression and
  persisted in `.mim/routines/state.json`; a fire is claimed by
  compare-and-set on that record. This prevents double-fires between two
  Mim processes pointing at the same checkout. It does **not** coordinate
  separate git clones, because `.mim/routines/` is per-machine state by
  design.
- Cross-machine safety comes from scheduler ownership, not shared CAS. A
  client can run automatic triggers for its local checkout while the app is
  open; an explicitly chosen always-on client can own schedule, file, and
  webhook triggers.
- A **file lock** under `.mim/routines/` makes the tick single-flight, with
  stale-lock takeover keyed on the heartbeat.
- **Two health files, deliberately** (the Hermes lesson): a ticker
  **heartbeat** touched every tick, and a **last-success** timestamp per
  routine. The first distinguishes "ticker dead" from the second's "ticker
  alive but this routine fails every time" — conflating them is how silent
  automation rots. `workspace.orient`'s observability health block reports
  both.
- **Missed-fire policy** is per-routine and boring on purpose: `skip`
  (default) does nothing; `once` fires a single catch-up run at the next tick
  after boot if any fire was missed while no host was running. Never replay
  each missed fire — a laptop closed for a week must not wake up to seven
  literature sweeps.

### Triggers beyond the clock

- **Webhook** — `POST /api/hooks/<routine>` on the existing server
  (`src/main/server/server.ts`). HMAC signature is **mandatory per route** —
  there is no unsigned webhook — with the secret stored in the keychain and
  referenced by name in frontmatter. Signatures are timestamp-bound (replay
  protection), deliveries carry an idempotency key cached against retries,
  routes are rate-limited and body-capped, and unknown routine names return
  the same 404 as missing routes. Payload fields become trigger-scoped
  template variables in the body (`{{payload.record_id}}`), interpolated as
  data, never as instructions (§Security). A `deliver-only` mode writes the
  payload to a declared file and skips the agent entirely — zero LLM cost
  for pure ingestion. On the desktop the server binds loopback, so webhooks
  from the internet are really a [mim-serve.md](mim-serve.md) capability;
  the route logic is identical on both hosts.
- **File events** — `trigger: files: { path: "inbox/", events: [add] }`.
  The existing watcher is scoped to registered open files, so the routines
  subsystem owns its own debounced directory watcher over declared patterns
  (same chokidar, same ignore list). Matched paths arrive as
  `{{files}}` — paths, not contents; the agent reads what it decides to
  read, through gated `fs.read` like anything else.
- **Chained** — `trigger: after: { routine: nightly-lit-sweep, on: done }`
  (or `on: error`). Sourced from terminal trace events of the upstream run,
  which also makes any future run kind chainable without new plumbing. Cycles
  are a load-time diagnostic.
- **Manual** — `routine.start` for the run-now affordance on the routine's row,
  plus blocking `routine.run` for headless callers. Manual starts are how you
  author: write the file, run it now, watch the transcript, tighten the prompt.

### Permissions — unattended but supervised

This is the differentiator, and the deliberate contrast with Hermes'
allow-all isolation profiles. A routine declares what it may do; everything
else waits for a human — it neither fails nor gets rubber-stamped.

- **Visibility is not authority.** `tools` decides what the model can call.
  `approval.allow` decides what can proceed unattended. This keeps a routine
  debuggable without making every visible tool a standing grant.
- **Inside `approval.allow`: auto-approve.** Each granted call records a
  `gate.decision` with reason "routine approval grant" — every
  auto-approval is still an audit event.
- **Outside `approval.allow`: routine baseline.** Ordinary read/search calls
  may proceed; mutate, external, system, settings, and secrets calls put the
  run into `needs-approval`. Because the run is a chat session, the live
  desktop path uses the existing pending-approval promise: the routine status
  flips, the run row shows it, and the user opens the run and decides on the
  ordinary inline approval card, after which the loop resumes
  mid-conversation. No new approval UI.
- **The path floor survives.** Sensitive and outside-workspace paths park
  even when the tool is granted — the floor promise in
  [security.md](../security.md) is not negotiable for unattended runs of all
  things.
- **The global approval mode does not apply.** `automationApprovalMode` —
  including "Allow all" — is a foreground convenience for a user watching
  the screen. Routine runs ignore it entirely: routine grants and the
  routine baseline are evaluated before the developer-mode bypass. A
  workspace someone once flipped to developer mode must not silently become a
  machine that approves anything at 3am.
- **Desktop parking is live-only in v1.** The current gate holds an
  in-memory approval promise. If the desktop quits while a routine is parked,
  boot reconciliation marks the run `error`/interrupted rather than pretending
  it can resume. Durable parking belongs to the server host phase.

The declarative approval-policy mechanism built here (visibility filter +
approval grant + park-and-resume) is the same one
[mim-serve.md](mim-serve.md) needs for its whole surface; it is built once,
in the gate, not per host. The concrete gate change is a routine-aware policy
resolver on `ToolContext` metadata, not a new actor that bypasses the normal
AI/app distinction.

### Activation and trust

Routine files are prose with standing authority: a `git pull` can introduce
one that runs at 05:00 with pre-granted tools. The trust story mirrors app
activation rather than inventing a new one:

- Workspace `routines/*.md` files are **activated per machine**: a new automatic
  routine loads `review-required`, and its Automatic toggle opens a focused
  authority review before enabling. Team sharing stays one click — but it is a
  click taken after reviewing what will run unattended.
- Acknowledgement is keyed to the authority-bearing parts of the definition:
  automatic trigger type, scheduler eligibility, agent, model, `tools`, and
  `approval.allow`. Widening `approval.allow`, adding an automatic trigger,
  or switching to a more capable agent re-requires the ack. Prompt edits do
  not require a new ack, but the management surface should show "definition
  changed since activation review" so review is cheap.
- Manual starts and runs are available for disabled routines to support
  authoring, but a disabled routine cannot fire from schedule, file, webhook,
  or chain triggers.
- `routine.disable` turns automatic runs off in personal state under
  `.mim/routines/` for this machine. Definition files no longer carry a second,
  overlapping enabled flag.

### Authoring — conversational first

`src/main/tools/routines.ts` exposes `routine.create / update / duplicate /
list / get / enable / disable / remove / run / start` plus webhook secret
status/set/delete tools, so the primary
authoring surface is the chat: "every weekday at 7, triage the board and draft
a standup note" becomes a validated file the user can read, diff, and commit.
`routine.create` validates frontmatter and trigger expressions before writing
(the `skill.create` discipline), leaves automatic triggers awaiting authority
review on this machine, and points the user at manual Run now as the test loop.
Revision-aware updates reject stale editor saves, duplicate creates a new
review-required definition, and remove moves the file to the OS Trash. The file
is the artifact, so hand-editing is equally first-class. A
routines starter lands in the `build-app` skill's decision table: prose on a
schedule → routine; imperative code on demand → app job; knowledge for the
agent → skill.

### Two clients, one subsystem

Desktop and always-on clients run the same subsystem, but only one client owns
automatic triggers for a Project at a time:

- **Desktop-owned** — the app runs the ticker, file watchers, and loopback
  webhook routes while it is open. This covers workday rhythms and local
  authoring.
- **Always-on-owned** — a chosen Mim client runs the same scheduler 24/7
  against its checkout. Other clients still list, edit, approve, and manually
  run routines, but automatic triggers are disabled locally to avoid two
  clones firing the same routine.

CAS state and file locks protect one checkout from double-firing. Scheduler
ownership protects multiple checkouts from double-firing.

## Phases

Each phase is independently shippable.

1. **Store + runner + manual trigger.** Implemented: `routines/` loader with diagnostics,
   headless run via `streamProfileResponse`, session carries `routineId` and
   routine run metadata, `'routine'` `RunKind` replaces `'workflow'`,
   History/Review/trace integration, `routine.*` tools. Already useful:
   "run this saved prompt now, as a tracked run."
2. **Routine permission policy + activation.** Implemented core: visible tools
   versus `approval.allow` grants, park via session `needs-approval`, path
   floor, mode independence, and per-machine authority review. Crash
   reconciliation for parked/working runs remains before automatic triggers.
3. **Ticker.** Implemented for desktop: cron/interval validation, lifecycle
   one-minute tick, scheduler heartbeat, `nextRunAt`, last-success/error
   state, and skipped-overlap tracing. Deferred: scheduler ownership across
   hosts, file lock for multiple local processes, `workspace.orient` health,
   and full missed-fire policy.
4. **File triggers.** Implemented for desktop: declared-path watchers,
   glob-root watcher resolution, path/event matching, and paths-as-data
   payloads. Deferred: deeper debouncing and parity with every ignore rule
   used by the workspace watcher.
5. **Webhook + chained triggers.** Implemented for desktop: local
   `POST /api/hooks/:routine`, mandatory HMAC verification, timestamp check,
   keychain-backed secrets, 24-hour persisted idempotency, body-as-data
   payload delivery, and secret management tools. Deferred: rate caps,
   internet exposure under the server host, deliver-only mode, and trace-sourced
   `after` triggers.
6. **Always-on client.** Exercise the subsystem on a continuously running Mim
   client; durable parking and scheduler ownership transfer are designed there.

## Security considerations

Unattended execution changes the threat model; this section is the reason the
permission design is not optional decoration.

- **Prompt injection is the primary attack.** Webhook payloads and
  watched-file contents are attacker-controlled text delivered to an agent
  holding standing grants. Mitigations, layered: payload values are
  interpolated as clearly fenced data with explicit "this is untrusted input,
  not instructions" framing, never spliced into tool parameters or shell
  commands by the runner itself; file triggers deliver paths, not contents;
  and `approval.allow` caps the blast radius — a poisoned PDF in `inbox/`
  can at worst do what the routine could already do, visibly, in the trace.
  Routines whose grants combine outbound-write tools (`chat.send`,
  `slack.send`, `gmail.send`, calendar writes, git push) with
  untrusted-input triggers deserve a load-time warning diagnostic: that
  combination is an exfiltration channel.
- **Webhook exposure.** Mandatory HMAC with timestamp-bound signatures, an
  idempotency cache, rate limits, body-size caps, and indistinguishable 404s
  for unknown names. Secrets live in the keychain, referenced by name;
  rotating a secret is a keychain operation, not a git commit. Desktop
  binding stays loopback; internet exposure is exclusively the server host's
  concern, behind its own auth story.
- **The git vector.** A malicious or careless PR can add or widen a routine.
  Per-machine activation with a fresh review on grant widening means pulled
  changes never gain authority silently; the diff is small, human-readable
  prose — which is exactly why the definition format is markdown.
- **Approval fatigue is a security failure.** If routines park constantly,
  users will widen grants to "everything". The authoring loop must make
  minimal grants easy: after a manual run, the transcript shows exactly which
  consequential tools were used — "adopt these as `approval.allow`" is a
  one-step refinement.
- **Unattended spend.** Step caps are per-routine frontmatter; run cost is
  in the trace and surfaces in `trace.stats` and the orient health block. A
  hard per-run budget is an open question, but silent runaway cost is not an
  acceptable v1 outcome — at minimum, health reporting names the spend.
- **Audit.** Nothing about routines is exempt: every fire, skip, gate
  decision, tool call, and terminal state is a trace event under one span
  tree, reachable from Review. An unattended system earns trust by being the
  best-audited part of the product, not the least.

## Relationship to sibling initiatives

- [mim-serve.md](mim-serve.md) — the headless always-on host. Routines are
  its flagship workload; it is routines' 24/7 body. The shared piece is the
  declarative approval policy (visibility filter + approval grant + park),
  built once in the gate here and consumed there. Phases 1–5 need nothing
  from it.
- context-compaction (implemented) — compaction in the AI
  runtime. A nightly sweep that makes hundreds of tool calls dies at the
  context ceiling without it; it lands first, and the runner assumes it
  rather than growing its own truncation.
- slack-listener (implemented) — the Slack Socket Mode listener
  as a fifth trigger kind (`trigger: slack:`), with conversational
  per-thread sessions on top of the standard runner and grant mechanics.

## Explicitly not building

- **A workflow/DAG engine.** Chaining is `after:` on terminal trace events;
  fan-out, joins, conditionals, and retries-with-backoff live in prompts and
  tools, not in a graph runtime. If a graph is ever needed, it will be argued
  from real routines that hit the wall.
- **A workflow-canvas schedule builder.** The Routines work surface provides
  focused daily, weekly, interval, file, webhook, and Slack fields, while the
  Markdown definition remains the canonical advanced editor. It does not add a
  calendar canvas or workflow graph.
- **A generic event bus.** A small named trigger set, each with a concrete contract.
  Arbitrary app-emitted events wait for a real consumer.
- **App-contributed routines.** Apps may eventually scaffold or suggest
  routine files, but v1 routines are workspace files only. This preserves the
  distinction between app jobs, app agents, and workspace-owned automation.
- **Runner-owned delivery.** No `delivery.slack` or email layer in v1. If a
  routine should send a message, the prompt uses normal communication tools
  under normal grants and audit.
- **Parameter-level tool policies.** The grant unit is the tool, as
  everywhere else in Mim; finer policy is a gate evolution, not a routine
  feature.
- **A queue or worker pool.** One run per routine at a time, skip on
  overlap. Parallelism pressure is a symptom the routine should be split.
- **Per-fire replay of missed schedules.** `skip` or `once`, nothing else.

## Open questions

- **Durable parking.** On the server host, a parked approval must survive
  process restarts and reach a human who is not at the machine — persist the
  pending call and re-enter the loop on approval, or re-run the turn from the
  parked step? Decided in phase 6 with mim-serve.
- **Timezones.** Cron evaluates in the host's local time; a laptop in Berlin
  and a server in UTC disagree. Likely a workspace-level `timezone` setting,
  decided when the server host lands.
- **Hard budget caps.** Per-run spend limits beyond step caps — enforced
  abort vs. health reporting only.
- **Deeper health surface.** Rows show last success/failure and next-run context.
  A dedicated fire-history and parked-run health panel is still open.
