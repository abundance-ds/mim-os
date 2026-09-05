# Anonymous Usage Telemetry

Mim has a small first-party anonymous telemetry client in the main process. It
uses the existing trace stream as its primary source and sends only a redacted,
allowlisted projection to the configured endpoint.

## Storage And Identity

Machine-global state lives at:

```text
~/.mim/telemetry.json
```

Shape:

```json
{ "anonId": "<uuid>", "enabled": true, "firstSeen": "2026-06-14T00:00:00.000Z" }
```

`anonId` is generated once with `crypto.randomUUID()`. The renderer never
receives it; it is included only in outbound telemetry batches.

## Endpoint And Kill Switches

Endpoint precedence:

1. `MIM_TELEMETRY_ENDPOINT`
2. `~/.mim/config.yaml` `telemetry.endpoint`
3. built-in `DEFAULT_TELEMETRY_ENDPOINT`

The built-in endpoint is
`https://mim.abundanceds.com/api/v1/telemetry/events`.

Telemetry is disabled when:

- `MIM_TELEMETRY_DISABLED=1` or `true`
- `NODE_ENV=test`, unless a test explicitly opts in
- `~/.mim/telemetry.json` has `enabled: false`

Settings > Workspace exposes the machine-global toggle through the
`telemetry.status` and `telemetry.setEnabled` tools.

## Privacy Contract

Telemetry never transmits file contents, file names or paths, prompts, model
outputs, chat text, comments, snippets, search queries, terminal commands,
logbook text, keys, tokens, account labels, user identity, workspace identity,
trace ids, span ids, trace `summary`, trace `subject`, trace `payloadRef`, or
raw error messages.

Only low-cardinality categoricals and numeric counts leave the process. Event
and property validation is centralized in `src/main/telemetry/events.ts`.

## Event Sources

Trace sink mappings:

- `chat.turn` with `data.profile === "chat"` -> `chat_send`
- `model.call` -> `model_call`
- `tool.result` -> `tool_use`
- `tool.error` -> `tool_error`
- `job.done`, `job.failed`, `job.cancelled` -> `package_run`
- `gate.decision` -> `gate_decision`
- `export.pdf` / `export.docx` tool results -> `export`

Direct main-process lifecycle calls emit:

- `app_open`
- `workspace_open`

Renderer UI calls emit:

- `file_open`
- `theme_change`
- `ghost_accept`

The trace sink ignores `telemetry.*` tools so telemetry does not report itself.

## Transport

`src/main/telemetry/telemetry.ts` owns an in-memory queue:

- max queue length: 200
- flush interval: 60 seconds
- flush threshold: 100 queued events
- batch size: 100
- failed POSTs are requeued within the queue cap
- disabling telemetry clears the queue
- shutdown clears timers and performs a best-effort final flush

Wire shape:

```json
{ "events": [{ "anonId": "...", "eventType": "model_call", "props": {}, "appVersion": "0.1.0", "platform": "macos", "ts": "..." }] }
```

## Local Verification

To inspect outbound telemetry without contacting the hosted endpoint, run a
local receiver and point `MIM_TELEMETRY_ENDPOINT` at it:

```bash
node --input-type=module -e "import http from 'node:http'; http.createServer(async (req,res) => { let body=''; for await (const c of req) body += c; console.log(req.method, req.url, body); res.writeHead(204); res.end(); }).listen(8787, '127.0.0.1')"
```

Then launch Mim or a headless command with:

```bash
MIM_TELEMETRY_ENDPOINT=http://127.0.0.1:8787/events npm run dev
```

For isolated headless checks, set a temporary `HOME` so the smoke test does not
touch the real `~/.mim/telemetry.json`.

## Source Map

- Identity: `src/main/telemetry/identity.ts`
- Config: `src/main/telemetry/config.ts`
- Event normalization: `src/main/telemetry/events.ts`
- Transport: `src/main/telemetry/telemetry.ts`
- Tools: `src/main/tools/telemetry.ts`
- Electron wiring: `src/main/index.ts`
- Headless wiring: `src/main/headless.ts`
- CLI shutdown: `src/main/cli.ts`
- Settings state: `src/renderer/stores/settings.ts`
- Settings UI: `src/renderer/components/settings/StorageSettingsPanel.vue`
- Ghost acceptance hook: `src/renderer/components/editor/codemirror/ghost.js`
