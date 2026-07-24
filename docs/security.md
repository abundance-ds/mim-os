# Security & Permission Model

What the gate is: a speed-bump on **AI/app automation** so a user can catch an
unintended or destructive action before it runs. Defense in depth: the renderer is
hardened against XSS (DOMPurify on all v-html), IPC is locked to `actor: 'user'`,
and the local server restricts CORS to known origins.

## Enforcement point

`tools.call(name, params, ctx)` runs `gate.check(tool, params, ctx)` **before**
`tool.execute` (`src/main/tools/registry.ts`). A denied check throws `PermissionDeniedError`
and the body never runs. The Electron app (`index.ts`) and the headless CLI
(`headless.ts`) each construct a gate; a registry built without one enforces
nothing.

## Actors (`ctx.actor`) — this is the trust boundary

- `kernel:call` IPC **hardcodes** actor to **`user`** (`index.ts`). The renderer
  cannot claim `ai`/`package`/`system` — only main-process internals set those.
- **`user` / `system`** → always allowed, never prompts.
- **`ai`** → the only actor the interactive gate ever prompts. AI tool calls
  originate in main from the AI runtime with `actor: 'ai'` (`src/main/ai/aiRuntime.ts`), not via
  renderer IPC.
- **`package`** → declared-permission check only (`packagePermissionViolation`);
  pass → allowed silently, fail → throw. Apps never get an interactive prompt.

App-mounted agents (`export const agents` in a backend) execute as actor `ai`
through the same gate. Agents are backend exports, so the local app permission acknowledgement
already applies — no separate exemption.

Team and Project apps with executable backend or terminal UI code, or effective
workspace, AI, HTTP, or secret permissions, require that local acknowledgement
before activation. A terminal interface calls tools as the `package` actor, so
it remains inside the same manifest boundary as an iframe app view.

Consequence: the gate defends against the agent's autonomous actions and app
automation. The renderer cannot escalate because IPC is hardcoded to `user`.

## Modes

Source: Personal `~/.mim/config.yaml` preferences →
`automationApprovalMode` (`readApprovalMode` in `index.ts`); defaults to
`normal`.

- **strict** → every `ai` action prompts (reads included).
- **normal** → prompts when the tool's effect is `mutate` or `external`.
- **developer** (UI label "Allow all") → bypassed before any check; prompts nothing.

**Path floor:** a `sensitive` or `outside-workspace` path always prompts under
strict + normal, regardless of effect — including when a session "always allow"
is active for the same tool. The floor is checked before session allows so it
can never be suppressed. Developer bypasses it (the bypass is checked before
the floor).

## Effect is the prompt key — not risk

`toolEffect(name)` = `EFFECT_OVERRIDES[name]` ?? `categoryEffect(policy.category)`
(`src/main/security/gate.ts`).

- `categoryEffect`: `read`/`search`/`ai` → **read**; `network` → **external**;
  everything else (`write`/`secrets`/`system`/`settings`/`ui`/`general`) **and any
  unmapped tool** → **mutate**.
- **`read` means "no prompt in Normal, still prompt in Strict."** So it doubles as
  the exemption tag for benign mutations. `EFFECT_OVERRIDES` uses it for internal
  writes (`workspace.orient`, `log.append`) and for reads/navigation mis-filed in a
  mutating bucket (`editor.open`, `workbench.open*`, `settings.get`, status pings).
- **Unknown tool → `mutate`** (prompts in Normal/Strict). To change a tool's
  behavior, edit `TOOL_POLICIES` (category) and/or `EFFECT_OVERRIDES`.
- `risk` (low/medium/high) no longer gates anything; it only sets the inline
  approval card's caution styling.

## Agent sessions (`agent.*`)

Agent sessions are interactive ptys carrying the user's full shell authority
(see [agent-sessions.md](agent-sessions.md)), so the gate treats the surface
specially:

- **`agent.launch` / `agent.stop` are user-only.** The `ai` actor is
  **hard-denied** before any approval flow or developer-mode bypass — the same
  pattern as `app.trust`. AI already has `terminal.run` for command execution;
  it cannot start or stop agent sessions.
- **The whole `agent.*` surface is denied to app actors**
  (`packagePermissionViolation` matches the `agent.` prefix): catalog,
  launch/kill, session records, and scrollback are all off-limits to apps.
- Effects for the `ai` actor where calls are allowed: `agent.list`,
  `agent.sessions.list`, and `agent.sessions.get` are `read` (no prompt in
  Normal, prompt in Strict). `agent.sessions.rename`/`archive` (category
  `ui`) and `agent.sessions.delete` (category `ui`, risk `medium`) are
  `mutate`, so they prompt in Normal and Strict. `agent.launch`/`agent.stop`
  are policy-listed (`general`/`medium`) but unreachable for `ai` because of
  the hard deny.

## Subagents (`subagent.*`)

Subagents are Mim-native AI threads, not user-authority PTYs. Their control
surface is available to `ai`, `user`, `system`, and allowlisted MCP callers;
`package` actors are hard-denied before normal app permission checks.

The main process creates trusted `ctx.subagent` metadata for child turns. The
gate enforces its effective tool allowlist on every AI call, independently of
what the model can currently see. The effective list is the intersection of
the parent profile, selected child profile, optional spawn narrowing, and the
workspace tool policy.

Normal mode treats spawn/wait/send/interrupt/stop/status/list/result as
coordination and does not prompt merely for those controls. Strict mode keeps
its every-action rule. `subagent.spawn.requestedGrants` is different: it forces
a real approval and only an approved request becomes a durable task-lineage
grant. The requested tool must already be in the child's inherited surface.

Local desktop MCP calls remain `actor: "user"` as described below.

## Sensitive paths (`src/main/security/gate-paths.ts`)

Locations: `.ssh .gnupg .aws .config/gcloud .kube .docker .npmrc .pypirc /etc
/private/etc /var/run /Library/Keychains`. Exact segments: `credentials secrets
.netrc .bashrc .zshrc .profile .bash_profile .bash_history .zsh_history`.
Prefix segments: `.env` (matches `.env`, `.env.production`, `.env.local`, etc.
but not `envelope.md` or `environment.ts`). SSH key patterns:
`id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa` and their `.pub` counterparts.
Classification → `workspace` | `team` | `sensitive` | `outside-workspace` |
`invalid`. Paths below `.mim/team/` are `team`: contributions are writable
under the normal actor rules, while mutation of the `.mim/team` checkout mount
itself is hard-denied.

## Redaction & audit (two separate redactors)

- **Approval request → renderer** carries `params` redacted by
  `redactPermissionParams` (`/content|key|token|password|secret/i`) **plus** a
  `preview` with **un-redacted** file content (`buildApprovalPreview`, from raw
  params). The un-redacted content is deliberate — it's the user's own file, shown
  so they can review the change. It never enters event summaries.
- **Persisted local audit**, when enabled, is the unified trace stream (`.mim/traces/YYYY-MM-DD.jsonl`,
  `src/main/trace/trace.ts`), with event `summary` fields produced in
  `src/main/tools/registry.ts` by a **broader** redactor:
  `/(^|_)(body|code|content|key|password|secret|snippet|subject|text|token)($|_)/i`
  — so send payloads (subject/body/text) are redacted there even though the card
  shows them. The same known-safe file-mutation set as the approval preview
  (`fs.write`/`fs.edit`/`fs.create`) additionally stores its raw params as
  compressed content-addressed payloads under `.mim/traces/objects/` —
  user-own-content, never keys or
  tokens; this is the edit-distance raw material for the learning loop
  (`plan-observability.md`). The workspace Local audit trail toggle can disable
  new local trace and payload writes and delete the existing local store.
- **Gate decision audit** is durable in both kernels: `index.ts` and
  `headless.ts` inject a `recordDecision` callback (`traceGateDecision`) that
  writes meaningful gate decisions (denied/requested/approved/bypassed) as a
  `gate.decision` trace event parented under the gated tool-call span. Routine
  allowed read-through is omitted. Params stay redacted. Logging is best-effort
  and never blocks; local persistence is skipped when the workspace audit trail
  is off.

## Code Execution Gate

Two registered tools provide command execution:

**`shell.run`** (AI key: `bash`) — full shell access with captured output. Gated
with `{ category: 'system', risk: 'high', targetParam: 'command' }`. The approval
card shows "run a shell command" plus the command string. Per-call approval with
session "always allow" checkbox.

**`code.run`** — allowlisted interpreter execution for the Render button and
headless CLI. Gated with `{ category: 'system', risk: 'high', targetParam: 'argv' }`.

The `shell.run` tool-policy row (`src/main/tools/toolPolicy.ts`) governs the
`bash` AI tool key with risk `sensitive` and `defaultEnabled: true`. Users
disable it in Settings > Tools to remove the `bash` tool from the AI tool set
entirely. Disabling it does NOT affect `code.run` (the Render button path).

The `code.run` row remains for the interpreter allowlist and Settings > Tools
interpreter toggles. Interpreter resolution enforces decision D6: only absolute
paths detected by the login shell are spawnable. The `codeInterpreters` setting
(default: `['rscript', 'r', 'quarto']`) further restricts which detected
interpreters `code.run` accepts.

## Session "Always allow"

The checkbox sets an allow key for the exact tool. Ordinary chats use
`${sessionId}:${tool.name}`. Delegated calls use
`${rootSessionId}:${tool.name}`, so descendants in the same task lineage share
the user's explicit trust while unrelated roots do not. There are no
per-action carve-outs, and the path floor still wins for
sensitive/outside-workspace paths. `cancelSession(rootSessionId)` clears a
lineage allow; cancelling any session also resolves its own pending approval
promises as denied. The renderer calls
`cancelGateSession` via the `gate:cancel-session` IPC in `handleStop`, and
clears the approval store queue so inline cards disappear immediately.

## Hardening layers

- **XSS mitigation**: all `v-html` sites (chat, editor preview, archive cards)
  sanitize through DOMPurify (`src/renderer/services/sanitize.ts`) with a strict
  allowlist of tags and attributes (inert structural tags like `details`/`figure`/
  `dl` are allowed; `data-*`, event handlers, and script-bearing tags are not).
- **CSP**: `src/renderer/index.html` carries a restrictive Content-Security-Policy
  meta (no inline script, connect/frame limited to the local kernel server and dev
  server) as defense in depth behind DOMPurify.
- **Symlink escape prevention**: `resolveWorkspacePath` in `src/main/tools/fs.ts`
  checks that symlinks — including dangling ones, whose targets a write would
  create — resolve inside the workspace. The one managed `.mim/team/` checkout
  is exempt so Team contributions work through normal file tools; the gate
  protects the mount itself. Errors during the check fail closed except ENOENT.
- **CORS**: the local Express server restricts `Access-Control-Allow-Origin` to
  the app's own `127.0.0.1:<port>`, `localhost:<port>`, `null` (file://), and
  the dev server origin. Foreign web pages get no CORS headers.
- **Routine webhooks**: `POST /api/hooks/:routine` is a local server route for
  active webhook routines. It requires an OS-keychain secret, timestamp-bound
  HMAC signature over the raw JSON body, and optional delivery-id idempotency
  before any routine run is created. Payloads enter the prompt as data, not as
  hidden instructions.
- **WebSocket identification**: every WS method including `packages.list` and
  `__meta.tools` requires `identify` first. App iframes identify with
  launch tokens. MCP clients identify with desktop-minted MCP bearer tokens.
  MCP connections are bound as `actor: "user"` — CLI agents have their own
  permission gates, and the MCP allowlist is the security boundary. Tools are
  server-allowlisted before tool dispatch; `packages.list` stays app-only. The discovery MCP token is
  valid for the desktop process lifetime; per-agent MCP tokens are revoked when
  their live agent session ends.
- **IPC actor**: renderer IPC is hardcoded `actor: 'user'` — the renderer cannot
  claim AI or app identity.
- **API key hygiene**: `~/.mim/keys.env` is written with `mode: 0o600` and
  re-`chmod`ed on every write (the mode option alone does not fix pre-existing
  files); Gemini API key uses the `x-goog-api-key` header (not the URL query
  string).
- **App HTTP redirects**: `redirect: 'manual'` prevents automatic redirect
  following that could bypass the host allowlist.
- **Web URL SSRF block**: `parseAllowedHttpUrl` accepts only `http`/`https` and
  rejects private, loopback, link-local, unique-local, unspecified, and cloud
  metadata addresses by default. Tests/local development must opt in with the
  explicit `allowPrivateAddresses` escape hatch. The desktop live browser uses
  the narrower `allowLoopbackAddresses` option only for a session whose initial
  URL is itself loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`).
  Its HTTP(S) and WebSocket request blocker carries that per-session decision:
  public pages cannot pivot into localhost, and all non-loopback private ranges
  remain denied. Headless runtimes never receive the Electron driver.

## Known limits

- `developer` mode and `user`/`system`/`package` actors all bypass interactive prompts.
- No durable app permission manifest or policy engine (README tech debt).
- `BrowserWindow` uses `sandbox: false`; enabling sandbox is a future hardening step.
- App iframes use `allow-same-origin` (required for SDK WebSocket); full
  origin isolation is an architectural follow-up. A per-boot shell token
  (`x-mim-shell-token`) guards `/api/ai/*` routes so iframes cannot drive the
  AI runtime directly — only the trusted renderer shell (via preload bridge)
  obtains the token.
- Local images must go through `fs.readImageDataUrl`, not `file://`.

## Tests

- `src/main/security/gate.test.ts` — effect classification, each mode, the path floor,
  preview shape, the redaction invariant (preview carries content while the audit
  event stays redacted), the `log.append` Normal-exemption-but-Strict-prompt,
  sensitive-path floor vs session always-allow (Fix 1), durable audit events
  (Fix 2), cancelSession resolves pending approvals as denied (Fix 4), agent
  session tool policies and the user-only `agent.launch`/`agent.stop` denial.
- `src/main/tools/registry.test.ts` — registry runs the gate before execute, suspends until
  it resolves, blocks execution on denial, and redacts event summaries.
- `src/main/tools/fs.test.ts` — symlink escape prevention: rejects symlinks
  pointing outside workspace for read/write/delete (including dangling links),
  rejects symlinked directories, allows workspace-internal symlinks, and exempts
  the one managed `.mim/team/` checkout.
- `src/renderer/services/sanitize.test.ts` — DOMPurify wrapper strips scripts,
  event handlers, iframes, forms, `javascript:` hrefs, and `data-*` attributes.
- `src/main/server/server.test.ts` — CORS origin restriction: allows same-origin
  and `null`, denies foreign origins; `packages.list` refused before WS
  identification; MCP identify, metadata, server-side allowlist, app-only
  app listing, and AI actor/session routing.
- `src/main/web/urlPolicy.test.ts` — private, loopback, link-local, unique-local,
  and cloud metadata URL blocking.
- `src/main/packages/packageHttp.test.ts` — verifies `redirect: manual` is passed
  to the HTTP client.
- UI: `InlineApproval.smoke.test.ts`, `approvalLogic.test.ts`,
  `approvalSummary.test.ts`, `services/approvalDiff.test.ts`,
  `stores/approvals.test.ts`, `DiffReviewBar.smoke.test.ts` (approval branch).
