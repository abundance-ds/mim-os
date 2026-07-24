---
id: tools
title: tool catalog
generated: true
---

# tool catalog

Every tool registered in the Mim tool registry. Effect determines the approval
behavior: read tools are auto-approved, mutate and external tools require your
approval.

## ai

| tool | description | effect | approval |
|---|---|---|---|
| `ai.registry` | Get the model registry | read | auto |
| `ai.keyStatus` | Check which AI providers have keys configured | read | auto |
| `ai.setKey` | Save an API key to ~/.mim/keys.env | **mutate** | ask |
| `ai.clearKey` | Remove a provider API key from ~/.mim/keys.env | **mutate** | ask |
| `ai.generateObject` | Generate a structured JSON object with a configured AI model. Intended for package backend jobs. | read | auto |

## always-on

| tool | description | effect | approval |
|---|---|---|---|
| `always-on.status` | Read this headless client runtime state. | read | auto |

## app

| tool | description | effect | approval |
|---|---|---|---|
| `app.status` | List available Mim, Team, and Project apps with this person’s local activation state. | read | auto |
| `app.enable` | Enable an available app for this person in the current local Project checkout. | **mutate** | ask |
| `app.disable` | Disable an app for this person in the current local Project checkout. | **mutate** | ask |
| `app.trust` | Approve the declared access of a Team or Project app on this machine. | **mutate** | ask |
| `app.agents.list` | List agent profiles supplied by enabled apps. | **mutate** | ask |

## archive

| tool | description | effect | approval |
|---|---|---|---|
| `archive.list` | List archived sessions, package runs, and agent sessions with a content preview | **mutate** | ask |
| `archive.search` | Full-text search within archived sessions | **mutate** | ask |

## awareness

| tool | description | effect | approval |
|---|---|---|---|
| `awareness.recent` | Show fetched Project and Team file changes with authors. | read | auto |

## calendar

| tool | description | effect | approval |
|---|---|---|---|
| `calendar.events` | Read Google Calendar events in a time range. | external | ask |
| `calendar.create` | Create a Google Calendar event. | external | ask |

## code

| tool | description | effect | approval |
|---|---|---|---|
| `code.run` | Run a script with a detected interpreter (Rscript, R, quarto) in the workspace. Write code to a real file first, then ru | **mutate** | ask |

## comments

| tool | description | effect | approval |
|---|---|---|---|
| `comments.list` | List inline review comment threads in a file. Markdown files use inline <comment> tags; code and plain-text files use @m | read | auto |
| `comments.add` | Add an inline review comment anchored to exact visible text. Works on markdown (inline <comment> tags) and code/plain-te | **mutate** | ask |
| `comments.reply` | Append a reply note to an existing inline review comment thread. | **mutate** | ask |
| `comments.resolve` | Resolve inline review comments by removing wrappers and notes while keeping the anchored text. Pass id to resolve one th | **mutate** | ask |

## config

| tool | description | effect | approval |
|---|---|---|---|
| `config.setUser` | Update Personal name, email, and timezone. | **mutate** | ask |
| `config.get` | Get Personal identity, preferences, model defaults, skill activation, and Team repository. No secrets. | read | auto |

## core

| tool | description | effect | approval |
|---|---|---|---|
| `search` | Search workspace files and/or session history. Use scope to target: "files", "sessions", or "all" (default). | **mutate** | ask |

## docs

| tool | description | effect | approval |
|---|---|---|---|
| `docs.read` | Export a Google Doc as plain text. | external | ask |

## documents

| tool | description | effect | approval |
|---|---|---|---|
| `documents.docx.read` | Read a workspace DOCX file into LLM-readable text. | read | auto |
| `documents.docx.extract` | Extract a workspace DOCX file into review HTML, markdown, text, and images. | read | auto |
| `documents.docx.annotate` | Create a reviewed DOCX copy with Word comments or tracked changes. The original file is not modified. | **mutate** | ask |
| `documents.docx.comments` | Read existing Word comments from a workspace DOCX file. | read | auto |
| `documents.docx.validate` | Validate a workspace DOCX file with the Open XML validator. | read | auto |
| `documents.docx.workerStatus` | Check whether the DOCX Open XML worker binary is available. | read | auto |
| `documents.pdf.extract` | Extract selectable text and embedded metadata from a workspace PDF. | read | auto |
| `documents.importMarkdown` | Convert a workspace .docx, .xlsx/.xlsm, .bib, or selectable .pdf file into AI-ready Markdown. JS/TS-only; scanned PDFs a | **mutate** | ask |
| `documents.importMarkdown.formats` | List file formats supported by documents.importMarkdown. | read | auto |

## drive

| tool | description | effect | approval |
|---|---|---|---|
| `drive.search` | Search Google Drive files. | external | ask |
| `drive.meta` | Read Google Drive file metadata. | external | ask |

## export

| tool | description | effect | approval |
|---|---|---|---|
| `export.pdf` | Export a markdown document to a styled PDF (layout options, fonts, optional BibTeX citations). Reads a workspace file or | **mutate** | ask |
| `export.docx` | Export a markdown document to a Word (.docx) file with the same layout options and citation handling as export.pdf. Work | **mutate** | ask |
| `export.styles` | List the page sizes and fonts available to export.pdf / export.docx, with their defaults. | read | auto |

## fs

| tool | description | effect | approval |
|---|---|---|---|
| `fs.read` | Read a file from the workspace. Returns line and truncation metadata. | read | auto |
| `fs.readImageDataUrl` | Read a workspace image file and return a data URL for secure local preview rendering. | read | auto |
| `fs.write` | Overwrite content in a workspace file | **mutate** | ask |
| `fs.writeBytes` | Overwrite a workspace file with base64-decoded binary bytes. | **mutate** | ask |
| `fs.edit` | Search-and-replace in one workspace file. Exactly one match is required. | **mutate** | ask |
| `fs.create` | Create a new file (fails if it already exists) | **mutate** | ask |
| `fs.delete` | Delete a workspace file. Directories are refused. | **mutate** | ask |
| `fs.trash` | Move a workspace file or directory to the OS trash (recoverable). | **mutate** | ask |
| `fs.copy` | Copy a workspace file or directory. Without new_path, picks a collision-free "<name> copy" sibling. | **mutate** | ask |
| `fs.import` | Copy an external file or directory into the workspace (drag-drop / explicit ingestion). Source must be an absolute path  | **mutate** | ask |
| `fs.list` | List workspace directory entries. Recursive mode skips heavy/generated directories. | read | auto |
| `fs.exists` | Check if a path exists in the workspace | read | auto |
| `fs.openNative` | Open a workspace file with the default system application. | read | auto |
| `fs.mkdir` | Create a directory recursively | **mutate** | ask |
| `fs.rename` | Rename or move a workspace path. Destination must not exist. | **mutate** | ask |

## git

| tool | description | effect | approval |
|---|---|---|---|
| `git.status` | Read concise git status for the current workspace. | read | auto |
| `git.diff` | Read git diff for the current workspace or one path. | read | auto |
| `git.log` | Read recent git commits for the current workspace. | read | auto |
| `git.commit` | Stage all workspace changes and create a git commit. | **mutate** | ask |
| `git.pull` | Pull from the current git remote using --ff-only. | external | ask |
| `git.push` | Push the current branch to its configured upstream. | external | ask |

## gmail

| tool | description | effect | approval |
|---|---|---|---|
| `gmail.search` | Search Gmail messages, or list recent messages when query is omitted. | external | ask |
| `gmail.read` | Read a Gmail message or thread body by id. | external | ask |
| `gmail.send` | Send a plain-text Gmail message, optionally as a threaded reply. | external | ask |

## google

| tool | description | effect | approval |
|---|---|---|---|
| `google.setOAuthClient` | Store a Google OAuth desktop client in the OS keychain. Accepts a file path to a Google Cloud Console JSON download, or  | **mutate** | ask |
| `google.setTokenBundle` | Store a Google OAuth token bundle in the OS keychain. Accepts a file path to a JSON token bundle, or inline parameters. | **mutate** | ask |
| `google.connect` | Connect Google through browser OAuth, or store a token bundle (inline or from file) and verify it with userinfo. | **mutate** | ask |
| `google.disconnect` | Remove a Google token bundle from the OS keychain. | **mutate** | ask |
| `google.status` | Report whether Google OAuth client and token are configured. | read | auto |
| `google.authUrl` | Build a Google OAuth consent URL for the configured OAuth client. | read | auto |
| `google.exchangeCode` | Exchange a Google OAuth code for tokens and store them in the OS keychain. | external | ask |

## history

| tool | description | effect | approval |
|---|---|---|---|
| `history.list` | List local recovery versions for a workspace file. | read | auto |
| `history.preview` | Preview a local recovery version. Text versions include content; binary versions report metadata only. | read | auto |
| `history.restore` | Restore a file to a local recovery version. The restore itself is captured as a new recovery point. | **mutate** | ask |
| `history.openVersion` | Write a recovery version to a temporary file so it can be opened without changing the workspace file. | read | auto |
| `history.stats` | Report local recovery storage use for the current workspace. | read | auto |
| `history.clear` | Clear local recovery history for the current workspace without touching workspace files. | **mutate** | ask |
| `history.prune` | Thin local recovery storage to the currently visible version-density policy. | **mutate** | ask |
| `history.baseline` | Create initial local recovery points for eligible workspace files that do not have history yet. | read | auto |

## instruction

| tool | description | effect | approval |
|---|---|---|---|
| `instruction.list` | List composed instruction origins and their editor paths. | read | auto |
| `instruction.open` | Ensure and return the normal editor path for one instruction origin. | **mutate** | ask |

## log

| tool | description | effect | approval |
|---|---|---|---|
| `log.append` | Append a short durable activity note to .mim/log.md. | read | auto |
| `log.read` | Read the optional human-readable activity logbook from .mim/log.md. | read | auto |

## references

| tool | description | effect | approval |
|---|---|---|---|
| `references.readBib` | Read the workspace BibTeX library and return citation rows for the editor. | read | auto |
| `references.resolveBibliography` | Resolve the active bibliography for a markdown document using the quiet priority order shared by editor and export. | **mutate** | ask |
| `references.setBibliographyPath` | Set the active bibliography after validating it is a Project or Team .bib file. | **mutate** | ask |

## routine

| tool | description | effect | approval |
|---|---|---|---|
| `routine.list` | List Team and Project routines with validation diagnostics | read | auto |
| `routine.get` | Get a workspace routine definition | read | auto |
| `routine.create` | Create a Team or Project routine definition; automatic runs require local review | **mutate** | ask |
| `routine.update` | Update a workspace routine definition if it has not changed since it was opened | **mutate** | ask |
| `routine.duplicate` | Duplicate a workspace routine; automatic runs require local review | **mutate** | ask |
| `routine.enable` | Enable automatic runs on this machine after reviewing the routine authority | **mutate** | ask |
| `routine.disable` | Disable automatic runs for a routine on this machine | **mutate** | ask |
| `routine.remove` | Move a workspace routine definition to the OS trash and clear its local run state | **mutate** | ask |
| `routine.run` | Run a workspace routine once as a normal chat turn and wait for completion | **mutate** | ask |
| `routine.start` | Start a workspace routine once and return its chat session immediately | **mutate** | ask |
| `routine.webhook.secret.status` | Check whether a webhook-triggered routine has its local signing secret configured | **mutate** | ask |
| `routine.webhook.secret.set` | Store a webhook-triggered routine signing secret in the OS keychain for this machine | **mutate** | ask |
| `routine.webhook.secret.delete` | Remove a webhook-triggered routine signing secret from the OS keychain on this machine | **mutate** | ask |

## search

| tool | description | effect | approval |
|---|---|---|---|
| `search.sessions` | Full-text search across session message history | read | auto |
| `search.files` | Search workspace file contents for a query string | read | auto |

## session

| tool | description | effect | approval |
|---|---|---|---|
| `session.create` | Create a new chat session | **mutate** | ask |
| `session.list` | List all sessions | read | auto |
| `session.get` | Get a session with full messages | read | auto |
| `session.update` | Update a session (label, messages, usage, etc.) | **mutate** | ask |
| `session.reorder` | Persist manual session ordering | **mutate** | ask |
| `session.delete` | Permanently delete a session | **mutate** | ask |

## settings

| tool | description | effect | approval |
|---|---|---|---|
| `settings.get` | Read all settings or a specific key | read | auto |
| `settings.set` | Write a setting | **mutate** | ask |

## sheets

| tool | description | effect | approval |
|---|---|---|---|
| `sheets.meta` | Read Google Sheets spreadsheet metadata and tab names. | external | ask |
| `sheets.read` | Read values from a Google Sheet range. | external | ask |
| `sheets.write` | Write values into a Google Sheet range. | external | ask |
| `sheets.append` | Append values to a Google Sheet range. | external | ask |

## shell

| tool | description | effect | approval |
|---|---|---|---|
| `shell.run` | Run a shell command in the workspace with captured output. | **mutate** | ask |

## skill

| tool | description | effect | approval |
|---|---|---|---|
| `skill.list` | List available AI skills as metadata only. Body text is returned by skill.get. Pass detailed=true for Settings metadata  | read | auto |
| `skill.get` | Activate a skill by name or package-qualified id and return its SKILL.md body plus declared tools. | read | auto |
| `skill.setDisabled` | Enable or disable an authored skill globally by writing skills.disabled in ~/.mim/config.yaml. | **mutate** | ask |
| `skill.create` | Create a new skill for You, the current Project, or the connected Team. | **mutate** | ask |
| `skill.update` | Replace one Personal SKILL.md if it has not changed since it was read. | **mutate** | ask |
| `skill.templateList` | List built-in starter templates for creating authored skills. | read | auto |
| `skill.templateContent` | Render a built-in starter skill template without writing files. | read | auto |
| `skill.inspectImport` | Inspect a SKILL.md folder before importing it into You, Project, or Team. | read | auto |
| `skill.import` | Import an inspected skill folder into You, Project, or Team. Requires confirmed=true. | **mutate** | ask |
| `skill.delete` | Delete a writable skill from You, Project, or Team. | **mutate** | ask |

## slack

| tool | description | effect | approval |
|---|---|---|---|
| `slack.setToken` | Store a Slack token in the OS keychain for an account label. | **mutate** | ask |
| `slack.deleteToken` | Delete a Slack token from the OS keychain for an account label. | **mutate** | ask |
| `slack.status` | Check whether Slack is configured and, when configured, verify the token with Slack auth.test. | read | auto |
| `slack.channels` | List Slack public and private channels for the configured account. | external | ask |
| `slack.users` | List Slack users for the configured account. | external | ask |
| `slack.dms` | List Slack direct-message conversations for the configured account. | external | ask |
| `slack.history` | Read Slack conversation history for a channel. | external | ask |
| `slack.search` | Search Slack messages for the configured account. | external | ask |
| `slack.send` | Post a Slack message to a channel. | external | ask |
| `slack.connect` | Store a Slack token and verify it. Accepts a file path to a token file (plain text or JSON with token field), or an inli | **mutate** | ask |
| `slack.disconnect` | Remove a Slack token from the OS keychain. | **mutate** | ask |
| `slack.bot.status` | Check whether Slack bot and Socket Mode credentials are configured for an account. | read | auto |
| `slack.bot.connect` | Store Slack bot and app-level Socket Mode tokens and verify both. Accepts a JSON file with bot_token and app_token, or i | **mutate** | ask |
| `slack.bot.disconnect` | Remove Slack bot and app-level Socket Mode tokens from the OS keychain. | **mutate** | ask |
| `slack.bot.setup` | Set up a workspace Slack bot in one step: optionally store bot credentials, create/update the Slack routine, and enable  | **mutate** | ask |
| `slack.bot.check` | Return one workspace Slack bot readiness checklist: routine binding, activation, credentials, and live listener availabi | read | auto |
| `slack.listener.status` | Check the local Slack Socket Mode listener runtime. | read | auto |
| `slack.replies` | Read threaded Slack replies for a message. | external | ask |

## subagent

| tool | description | effect | approval |
|---|---|---|---|
| `subagent.spawn` | Create a durable child agent thread and return immediately | **mutate** | ask |
| `subagent.wait` | Wait for child state changes without limiting child runtime | read | auto |
| `subagent.send` | Steer a running child or start a contextual follow-up turn | **mutate** | ask |
| `subagent.interrupt` | Interrupt the active child turn and optionally redirect it | **mutate** | ask |
| `subagent.stop` | Stop automatic child work while retaining its transcript | **mutate** | ask |
| `subagent.status` | Read one child thread status and result summary | read | auto |
| `subagent.list` | List child threads in this task lineage | read | auto |
| `subagent.result` | Read a child final response by character page | read | auto |

## sync

| tool | description | effect | approval |
|---|---|---|---|
| `sync.status` | Plain-language backup/sync status for the current workspace. | read | auto |
| `sync.configure` | Set the explicit workspace sync mode in mim.yaml. Managed mode may also set an origin remote. | **mutate** | ask |
| `sync.now` | Run the managed sync workflow. Refuses Manual mode. | external | ask |

## team

| tool | description | effect | approval |
|---|---|---|---|
| `team.status` | Read the one Personal Team connection, checkout contract, contribution summary, and Git sync state. | read | auto |
| `team.connect` | Connect the one Team Git repository using system Git credentials, clone it, and validate its fixed contract. | external | ask |
| `team.open` | Resolve the connected Team checkout and its fixed contribution paths. | read | auto |
| `team.sync` | Commit, rebase, and push writable Team changes using the connected repository and system Git credentials. | external | ask |

## telemetry

| tool | description | effect | approval |
|---|---|---|---|
| `telemetry.track` | Record an allowlisted anonymous usage telemetry event. | read | auto |
| `telemetry.status` | Read anonymous telemetry enabled state. Does not return the anonymous id. | read | auto |
| `telemetry.setEnabled` | Enable or disable anonymous usage telemetry for this machine. | **mutate** | ask |

## toolPolicy

| tool | description | effect | approval |
|---|---|---|---|
| `toolPolicy.get` | Read normalized agent tool availability policy for Settings > Tools. | read | auto |
| `toolPolicy.set` | Write normalized agent tool availability policy for Settings > Tools. | **mutate** | ask |

## toolchain

| tool | description | effect | approval |
|---|---|---|---|
| `toolchain.status` | Report detected interpreters (R, Rscript, Quarto, pandoc, python3) with versions and paths | read | auto |

## trace

| tool | description | effect | approval |
|---|---|---|---|
| `trace.query` | Read filtered trace digest events from the current workspace. Payload blob refs are returned by pointer only. | read | auto |
| `trace.stats` | Aggregate trace counts, errors, durations, model cost, gate decisions, job health, and outcome signals. | read | auto |
| `trace.payload` | Read a captured trace payload blob by its payloadRef (redacted model I/O or tool result). | **mutate** | ask |
| `trace.storage` | Report local trace digest and payload storage usage. | read | auto |
| `trace.prune` | Apply trace digest retention, payload retention, and the payload byte budget now. | **mutate** | ask |

## web

| tool | description | effect | approval |
|---|---|---|---|
| `web.read` | Read a URL through the workhorse web reader: PDFs use local text extraction, ordinary pages render in stateless Chromium | external | ask |
| `web.browser.status` | Return website access enablement, domain grants, and runtime availability. | read | auto |
| `web.browser.allowDomain` | Approve website access for a domain. | **mutate** | ask |
| `web.browser.removeDomain` | Remove a website access domain grant. | **mutate** | ask |
| `web.browser.open` | Open a visible browser window to set up website access. | external | ask |
| `web.browser.clearProfile` | Clear cookies, storage, and cache used for website access. | **mutate** | ask |
| `web.live.open` | Open a Markanywhere-style live browser session for public websites or localhost development servers and return a bounded | external | ask |
| `web.live.act` | Run one Markanywhere-style live browser action: observe, click, type, scroll, wait, extract, show, hide, or close. | external | ask |
| `web.search` | Search the web via Exa and return results with title, URL, and snippet. Requires EXA_API_KEY. | external | ask |

## workspace

| tool | description | effect | approval |
|---|---|---|---|
| `workspace.status` | Report whether the current workspace has been initialized with the Mim contract files. | **mutate** | ask |
| `workspace.init` | Initialize the current workspace: write mim.yaml, AGENTS.md, CLAUDE.md, .mim/, and .gitignore. | **mutate** | ask |
| `workspace.open` | Open a folder as a workspace. Creates .mim/ if needed. | **mutate** | ask |
| `workspace.orient` | Regenerate the runtime agent context file (.mim/agent-context.md) for the current workspace and return it. | read | auto |
| `workspace.info` | Get info about the current workspace | read | auto |
| `workspace.defaultAgentsMd` | Return the default AGENTS.md template content. | **mutate** | ask |
