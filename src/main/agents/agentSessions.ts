// Agent session lifecycle: each launched CLI agent (Claude Code, Codex, ...)
// is a first-class run with a persisted record, scrollback capture, and a
// status lifecycle. Deliberately mirrors packages/packageJobs.ts shapes
// (persist via atomicWriteJson on every transition, boot-time stale
// reconciliation, rename/archive/delete, active count for the close guard).
//
// System boundaries are injected: the pty spawn factory (pty.ts in
// production), the emit-to-windows function, clock, and id generator — so
// tests never touch node-pty or Electron.

import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { atomicWriteJson } from '@main/atomicJson.js'
import { createAgentStatusTracker, isSpinnerPrefix, type AgentRuntimeStatus, type AgentStatusTracker } from '@main/agents/agentStatus.js'
import {
  AGENT_CATALOG,
  assertAgentExtraArgs,
  assertDetectedAgentAvailable,
  launchArgs as catalogLaunchArgs,
  resumeArgs as catalogResumeArgs,
  cliSessionsDir,
  extractCodexSessionId,
} from '@main/agents/agentCatalog.js'
import type { DetectedAgent } from '@main/agents/agentCatalog.js'
import { resolveBundledAgentResource } from '@main/agents/agentResources.js'
import type { PtyHandle, PtySpawnOptions } from '@main/pty.js'

// Scrollback cap: the .scrollback file grows by raw append until it exceeds
// MAX, then is rewritten keeping only the most recent KEEP bytes (truncation
// from the front). Coarse byte-level truncation is fine — xterm replay
// resynchronises on the next escape sequence.
export const SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024
export const SCROLLBACK_KEEP_BYTES = 1024 * 1024

// ── Auto-title extraction ──
// When an agent session starts working (spinner prefix appears in titleHint),
// we attempt to assign a descriptive title. For Claude Code the titleHint
// itself carries the task description; for Codex and Gemini CLI we extract
// the user's prompt from the scrollback.

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?<>=]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[^[\]PX^_\x1b]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function isAgentIndicatorChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  if (code >= 0x2800 && code <= 0x28FF) return true
  if (code === 0x2726) return true
  if (code === 0x2733) return true
  if (code === 0x25C7) return true
  return false
}

export function cleanTitleHint(hint: string | undefined): string {
  if (!hint) return ''
  let text = hint
  while (text.length > 0 && isAgentIndicatorChar(text.charAt(0))) text = text.slice(1)
  return text.trim()
}

const AGENT_NAMES_LC = new Set(['claude code', 'codex', 'gemini cli', 'pi'])

export function isTrivialTitle(cleaned: string, cwd?: string): boolean {
  if (!cleaned || cleaned.length < 3) return true
  const lc = cleaned.toLowerCase()
  if (AGENT_NAMES_LC.has(lc)) return true
  if (cwd) {
    const cwdBase = basename(cwd)
    if (cleaned === cwdBase) return true
    if (cleaned.includes(`(${cwdBase})`)) return true
  }
  if (/^(ready|working|working…|idle|done|loading)(\s|$)/i.test(cleaned)) return true
  return false
}

function isCleanTaskText(text: string): boolean {
  if (!text || text.length < 3) return false
  if (!/\w{2,}/.test(text)) return false
  const alphaCount = (text.match(/[a-zA-Z]/g) || []).length
  if (alphaCount < text.length * 0.4) return false
  if (/^[╭╮╰╯│─┌┐└┘▄▀█▐▛▜▝▘▟▗■□●○◇✳✦❯►▶]/.test(text)) return false
  if (/^[─═╔╗╚╝║╠╣╬]/.test(text)) return false
  if (/^\??\s*for\s+shortcuts/i.test(text)) return false
  if (/^(Shift\+Tab|Checking for updates|Welcome back)/i.test(text)) return false
  if (/^(OpenAI|Gemini CLI|Claude Code)\s*v?\d/i.test(text)) return false
  if (/^#[0-9a-f]{3,6}\s/i.test(text)) return false
  if (/Update available/i.test(text)) return false
  if (/^(model|directory|workspace|sandbox|branch):/i.test(text)) return false
  return true
}

// Codex renders these rotating composer examples after the same › marker used
// for submitted prompts. Raw PTY scrollback cannot distinguish them by marker,
// so reject the exact built-in examples before accepting a task title.
const CODEX_COMPOSER_PLACEHOLDERS_LC = new Set([
  'explain this codebase',
  'summarize recent commits',
  'implement {feature}',
  'find and fix a bug in @filename',
  'write tests for @filename',
  'improve documentation in @filename',
  'run /review on my current changes',
  'use /skills to list available skills',
  'check recently modified functions for compatibility',
  'how many files have been modified?',
  'will this algorithm scale well?',
])

function isCodexComposerPlaceholder(text: string): boolean {
  return CODEX_COMPOSER_PLACEHOLDERS_LC.has(text.replace(/\s+/g, ' ').trim().toLowerCase())
}

export function extractCodexPrompt(stripped: string): string | null {
  const parts = stripped.split('›')
  if (parts.length < 2) return null
  for (let i = 1; i < parts.length; i++) {
    let text = parts[i].trim()
    if (!text) continue
    text = text.replace(/\s+(?:gpt-\S+|o[134]-\S*|claude\S*)\s+(?:default|low|medium|high|xhigh)\s+[·•].*$/, '')
    text = text.replace(/\[0 q.*$/, '').trim()
    if (!text || text.length < 3) continue
    if (/^[0-9]+\.\s/.test(text)) continue
    if (/^(Skip|Press enter|Update|Yes|No|Do you trust|Working with|Trusting)/i.test(text)) continue
    if (isCodexComposerPlaceholder(text)) continue
    if (!isCleanTaskText(text)) continue
    return text
  }
  return null
}

export function extractGeminiPrompt(stripped: string): string | null {
  const lines = stripped.split('\n')
  let best = ''
  for (const line of lines) {
    const matches = line.matchAll(/(?:^|\s)>\s{1,4}(\S[^>]*?)(?=\s*>\s|\s*[▄▀│╭╮╰╯─┌┐└┘]|\s*$)/g)
    for (const m of matches) {
      const text = m[1].trim()
      if (!text || text.length < 2) continue
      if (text.startsWith('Type your message')) continue
      if (text.startsWith('Select Theme')) continue
      if (text.startsWith('_')) continue
      if (/^[0-9]+ GEMINI/i.test(text)) continue
      if (!isCleanTaskText(text)) continue
      if (text.length > best.length) best = text
    }
  }
  return best || null
}

function extractPromptFromScrollback(stripped: string): string | null {
  return extractCodexPrompt(stripped) || extractGeminiPrompt(stripped) || null
}

function isDefaultAgentTitle(title: string, agentId: string): boolean {
  const name = AGENT_CATALOG.find(d => d.id === agentId)?.name
  if (!name) return false
  if (title === name) return true
  const match = title.match(/^(.+) (\d+)$/)
  return match !== null && match[1] === name
}

const MAX_TITLE_CHARS = 40

function truncateTitle(text: string): string {
  if (text.length <= MAX_TITLE_CHARS) return text
  const truncated = text.slice(0, MAX_TITLE_CHARS)
  const lastSpace = truncated.lastIndexOf(' ')
  return lastSpace > MAX_TITLE_CHARS * 0.5 ? truncated.slice(0, lastSpace) : truncated
}

export type AgentSessionStatus = 'running' | 'done' | 'error' | 'stopped' | 'interrupted'

export interface AgentSessionRecord {
  sessionId: string
  agentId: string
  title: string
  command: string
  cwd: string
  status: AgentSessionStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  archived?: boolean
  titleHint?: string // last OSC 0/1/2 title seen; persisted on change
  cliSessionId?: string // agent CLI's own session ID, detected after spawn
  userArgs?: string[] // launch-time custom flags retained when the CLI needs them for exact resume
}

// Record plus live runtime state, merged for the renderer: ptyId lets it
// attach xterm to the running pty; runtimeStatus drives the needs-input dot.
// Neither field is ever persisted.
export interface AgentSessionRuntime extends AgentSessionRecord {
  ptyId?: number
  runtimeStatus?: AgentRuntimeStatus
  scrollback?: string
}

export interface AgentSessionEvent {
  type: 'session.started' | 'session.status' | 'session.exited' | 'session.changed' | 'session.deleted'
  session: AgentSessionRuntime
}

export interface AgentSessionsOptions {
  getWorkspacePath: () => string | null
  spawnPty: (options: PtySpawnOptions) => PtyHandle
  getMcpServerPort: () => number
  createMcpToken: (sessionId: string) => string
  revokeMcpToken: (token: string) => void
  emit?: (event: string, data: unknown) => void
  now?: () => Date
  generateId?: () => string
  scrollbackMaxBytes?: number
  scrollbackKeepBytes?: number
  idleThresholdMs?: number
  generateTitle?: (scrollbackText: string) => Promise<string | null>
  resolveAgentResource?: (resourcePath: string) => string | null
}

export interface AgentSessions {
  launch(agent: DetectedAgent, userArgs?: string[]): { record: AgentSessionRuntime; ptyId: number }
  resume(sessionId: string, agent: DetectedAgent): { record: AgentSessionRuntime; ptyId: number }
  stop(sessionId: string): AgentSessionRuntime
  stopAll(): void
  list(options?: { includeArchived?: boolean; archived?: boolean }): AgentSessionRuntime[]
  get(sessionId: string, options?: { scrollback?: boolean }): AgentSessionRuntime | null
  rename(sessionId: string, title: string): AgentSessionRuntime
  archive(sessionId: string, archived?: boolean): AgentSessionRuntime
  delete(sessionId: string): { deleted: string }
  reconcileStaleSessions(): void
  activeSessionCount(): number
}

interface LiveSession {
  record: AgentSessionRecord
  handle: PtyHandle
  tracker: AgentStatusTracker
  scrollbackPath: string
  scrollbackBytes: number
  // Set before handle.kill() so the exit handler classifies the exit as
  // 'stopped' regardless of the (non-zero) exit code the stop produces.
  stopRequested: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  autoTitleTimer?: ReturnType<typeof setTimeout>
  lastStatus: AgentRuntimeStatus
  lastTitleHint: string | undefined
  autoTitleAttempted: boolean
  mcpToken?: string
  preSpawnSessions?: Set<string>
  preSpawnDir?: string
}

export function createAgentSessions(options: AgentSessionsOptions): AgentSessions {
  const now = options.now ?? (() => new Date())
  const generateId = options.generateId ?? randomUUID
  const maxBytes = options.scrollbackMaxBytes ?? SCROLLBACK_MAX_BYTES
  const keepBytes = options.scrollbackKeepBytes ?? SCROLLBACK_KEEP_BYTES
  const idleThresholdMs = options.idleThresholdMs ?? 5000
  const active = new Map<string, LiveSession>()
  const resolveAgentResource = options.resolveAgentResource ?? resolveBundledAgentResource

  function managedArgs(agent: DetectedAgent): string[] {
    if (agent.mimToolConnection !== 'extension' || !agent.extensionResource) return []
    const extensionPath = resolveAgentResource(agent.extensionResource)
    return extensionPath ? ['--extension', extensionPath] : []
  }

  function requireWorkspace(): string {
    const workspacePath = options.getWorkspacePath()
    if (!workspacePath) throw new Error('No workspace open')
    return workspacePath
  }

  const sessionsDir = () => join(requireWorkspace(), '.mim', 'agent-sessions')
  const recordPath = (sessionId: string) => join(sessionsDir(), `${sessionId}.json`)
  const scrollbackPath = (sessionId: string) => join(sessionsDir(), `${sessionId}.scrollback`)

  function persist(record: AgentSessionRecord): void {
    atomicWriteJson(recordPath(record.sessionId), record)
  }

  function emitEvent(type: AgentSessionEvent['type'], session: AgentSessionRuntime): void {
    options.emit?.('agent:session-event', { type, session } satisfies AgentSessionEvent)
  }

  function withRuntime(record: AgentSessionRecord): AgentSessionRuntime {
    const live = active.get(record.sessionId)
    if (!live) return { ...record }
    return {
      ...record,
      ptyId: live.handle.ptyId,
      runtimeStatus: live.tracker.status(),
    }
  }

  // Quarantine convention from sessions.ts: a corrupt record never poisons
  // list/get — rename it `.corrupt` with a console.error and move on.
  function parseRecordFile(path: string): AgentSessionRecord | null {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as AgentSessionRecord
    } catch {
      renameSync(path, `${path}.corrupt`)
      console.error(`Corrupt agent session file renamed: ${path} -> ${path}.corrupt`)
      return null
    }
  }

  function readRecord(sessionId: string): AgentSessionRecord | null {
    // Live records are the same objects that get persisted, so disk is only
    // needed for sessions without a live pty.
    const live = active.get(sessionId)
    if (live) return live.record
    const path = recordPath(sessionId)
    if (!existsSync(path)) return null
    return parseRecordFile(path)
  }

  function requireRecord(sessionId: string): AgentSessionRecord {
    const record = readRecord(sessionId)
    if (!record) throw new Error(`Agent session not found: ${sessionId}`)
    return record
  }

  function readAllRecords(): AgentSessionRecord[] {
    const dir = sessionsDir()
    if (!existsSync(dir)) return []
    const records: AgentSessionRecord[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const record = parseRecordFile(join(dir, file))
      if (!record) continue
      records.push(active.get(record.sessionId)?.record ?? record)
    }
    return records
  }

  function defaultTitle(name: string): string {
    const taken = new Set(readAllRecords().map(record => record.title))
    if (!taken.has(name)) return name
    let n = 2
    while (taken.has(`${name} ${n}`)) n++
    return `${name} ${n}`
  }

  function appendScrollback(live: LiveSession, chunk: string): void {
    mkdirSync(dirname(live.scrollbackPath), { recursive: true })
    appendFileSync(live.scrollbackPath, chunk)
    live.scrollbackBytes += Buffer.byteLength(chunk)
    if (live.scrollbackBytes > maxBytes) {
      const buf = readFileSync(live.scrollbackPath)
      const tail = buf.subarray(Math.max(0, buf.length - keepBytes))
      writeFileSync(live.scrollbackPath, tail)
      live.scrollbackBytes = tail.length
    }
  }

  function clearIdleTimer(live: LiveSession): void {
    if (live.idleTimer != null) {
      clearTimeout(live.idleTimer)
      live.idleTimer = undefined
    }
  }

  function checkIdleTransition(live: LiveSession): void {
    live.idleTimer = undefined
    const status = live.tracker.status()
    if (status !== live.lastStatus) {
      live.lastStatus = status
      emitEvent('session.status', withRuntime(live.record))
    }
  }

  function detectCliSessionId(live: LiveSession): void {
    const dir = live.preSpawnDir
    if (!dir || !existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      if (live.preSpawnSessions!.has(f)) continue
      if (live.record.agentId === 'codex') {
        live.record.cliSessionId = extractCodexSessionId(f)
      } else {
        live.record.cliSessionId = f.replace('.jsonl', '')
      }
      live.preSpawnSessions = undefined
      if (live.record.cliSessionId) persist(live.record)
      return
    }
  }

  const AUTO_TITLE_DELAY_MS = 15000

  function clearAutoTitleTimer(live: LiveSession): void {
    if (live.autoTitleTimer != null) {
      clearTimeout(live.autoTitleTimer)
      live.autoTitleTimer = undefined
    }
  }

  function startAutoTitleTimer(live: LiveSession): void {
    live.autoTitleTimer = setTimeout(() => {
      live.autoTitleTimer = undefined
      if (live.autoTitleAttempted) return
      if (!isDefaultAgentTitle(live.record.title, live.record.agentId)) return
      if (attemptAutoTitle(live)) live.autoTitleAttempted = true
    }, AUTO_TITLE_DELAY_MS)
  }

  function setAutoTitle(live: LiveSession, title: string): void {
    clearAutoTitleTimer(live)
    live.record.title = title
    persist(live.record)
    emitEvent('session.changed', withRuntime(live.record))
  }

  function attemptAutoTitle(live: LiveSession): boolean {
    const { agentId, cwd } = live.record
    const cleaned = cleanTitleHint(live.record.titleHint)
    // Codex emits spinner titles while MCP servers start, before the first
    // submitted prompt. Its window title is therefore never sufficient task
    // evidence; wait for a non-placeholder › prompt in scrollback.
    if (agentId !== 'codex' && !isTrivialTitle(cleaned, cwd)) {
      setAutoTitle(live, truncateTitle(cleaned))
      return true
    }

    let stripped: string | undefined
    try {
      stripped = stripAnsi(readFileSync(live.scrollbackPath, 'utf-8'))
    } catch { return false }

    const prompt = extractPromptFromScrollback(stripped)
    if (prompt && !isTrivialTitle(prompt, cwd)) {
      setAutoTitle(live, truncateTitle(prompt))
      return true
    }

    // An LLM can turn Codex's composer example or startup output into a
    // plausible but false task title. Returning false keeps auto-title
    // retryable when a later spinner arrives after the real prompt.
    if (agentId === 'codex') return false

    if (options.generateTitle) {
      const llmInput = stripped.slice(-800)
      live.autoTitleAttempted = true
      options.generateTitle(llmInput).then(title => {
        if (!title) return
        if (!isDefaultAgentTitle(live.record.title, agentId)) return
        setAutoTitle(live, truncateTitle(title))
      }).catch(() => {})
      return true
    }

    return false
  }

  function onData(live: LiveSession, chunk: string): void {
    appendScrollback(live, chunk)
    if (live.preSpawnSessions) detectCliSessionId(live)
    live.tracker.feed(chunk)
    const status = live.tracker.status()
    const hint = live.tracker.titleHint()
    const statusChanged = status !== live.lastStatus
    const hintChanged = hint !== live.lastTitleHint

    clearIdleTimer(live)

    if (!statusChanged && !hintChanged) return // never emit per chunk
    live.lastStatus = status
    if (hintChanged) {
      live.lastTitleHint = hint
      live.record.titleHint = hint
      persist(live.record)

      if (!live.autoTitleAttempted && hint && isSpinnerPrefix(hint.charAt(0))
          && isDefaultAgentTitle(live.record.title, live.record.agentId)) {
        if (attemptAutoTitle(live)) live.autoTitleAttempted = true
      }
    }
    emitEvent('session.status', withRuntime(live.record))

    if (status === 'done' || status === 'needs-input') {
      live.idleTimer = setTimeout(() => checkIdleTransition(live), idleThresholdMs + 50)
    }
  }

  function onExit(live: LiveSession, exitCode: number): void {
    clearIdleTimer(live)
    clearAutoTitleTimer(live)
    active.delete(live.record.sessionId)
    revokeLiveMcpToken(live)
    live.record.status = live.stopRequested ? 'stopped' : exitCode === 0 ? 'done' : 'error'
    live.record.exitCode = exitCode
    live.record.endedAt = now().toISOString()
    persist(live.record)
    emitEvent('session.exited', { ...live.record })
  }

  function snapshotCliSessions(agentId: string, cwd: string): { dir: string; ids: Set<string> } | undefined {
    let dir = cliSessionsDir(agentId, cwd)
    if (!dir && agentId === 'codex') {
      const home = process.env.HOME || process.env.USERPROFILE || ''
      const d = now()
      dir = join(home, '.codex', 'sessions',
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'))
    }
    if (!dir || !existsSync(dir)) return undefined
    const ids = new Set<string>()
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jsonl')) ids.add(f)
    }
    return { dir, ids }
  }

  function launch(agent: DetectedAgent, userArgs: string[] = []): { record: AgentSessionRuntime; ptyId: number } {
    assertDetectedAgentAvailable(agent)
    assertAgentExtraArgs(agent.id, userArgs)
    const cwd = requireWorkspace()
    const sessionId = generateId()
    const args = catalogLaunchArgs(agent.id, sessionId, [...agent.args, ...userArgs], managedArgs(agent))
    const mcpToken = options.createMcpToken(sessionId)
    const record: AgentSessionRecord = {
      sessionId,
      agentId: agent.id,
      title: defaultTitle(agent.name),
      command: [agent.binPath, ...args].join(' '),
      cwd,
      status: 'running',
      startedAt: now().toISOString(),
      cliSessionId: agent.id === 'pi' ? sessionId : undefined,
      userArgs: userArgs.length > 0 ? [...userArgs] : undefined,
    }
    const snapshot = snapshotCliSessions(agent.id, cwd)
    const tracker = createAgentStatusTracker({ idleThresholdMs })
    const live: LiveSession = {
      record,
      handle: null as unknown as PtyHandle, // assigned below; pty callbacks fire async
      tracker,
      scrollbackPath: scrollbackPath(sessionId),
      scrollbackBytes: 0,
      stopRequested: false,
      lastStatus: tracker.status(),
      lastTitleHint: tracker.titleHint(),
      autoTitleAttempted: false,
      mcpToken,
      preSpawnSessions: snapshot?.ids,
      preSpawnDir: snapshot?.dir,
    }
    try {
      live.handle = options.spawnPty({
        file: agent.binPath,
        args,
        cwd,
        env: {
          MIM_PORT: String(options.getMcpServerPort()),
          MIM_TOKEN: mcpToken,
        },
        onData: (chunk) => onData(live, chunk),
        onExit: (exitCode) => onExit(live, exitCode),
      })
    } catch (err) {
      revokeLiveMcpToken(live)
      throw err
    }
    active.set(sessionId, live)
    persist(record)
    startAutoTitleTimer(live)
    const merged = withRuntime(record)
    emitEvent('session.started', merged)
    return { record: merged, ptyId: live.handle.ptyId }
  }

  function resume(sessionId: string, agent: DetectedAgent): { record: AgentSessionRuntime; ptyId: number } {
    assertDetectedAgentAvailable(agent)
    const record = requireRecord(sessionId)
    if (record.status === 'running') throw new Error(`Agent session is already running: ${sessionId}`)

    const retainedArgs = record.agentId === 'pi' ? [...agent.args, ...(record.userArgs ?? [])] : []
    const rArgs = catalogResumeArgs(record.agentId, record.cliSessionId, record.cwd, retainedArgs, managedArgs(agent))
    const mcpToken = options.createMcpToken(sessionId)

    record.status = 'running'
    delete record.endedAt
    delete record.exitCode
    record.startedAt = now().toISOString()
    record.command = [agent.binPath, ...rArgs].join(' ')
    if (record.archived) record.archived = false

    const tracker = createAgentStatusTracker({ idleThresholdMs })
    const sbPath = scrollbackPath(sessionId)
    const existingBytes = existsSync(sbPath) ? statSync(sbPath).size : 0

    const live: LiveSession = {
      record,
      handle: null as unknown as PtyHandle,
      tracker,
      scrollbackPath: sbPath,
      scrollbackBytes: existingBytes,
      stopRequested: false,
      lastStatus: tracker.status(),
      lastTitleHint: record.titleHint,
      autoTitleAttempted: !isDefaultAgentTitle(record.title, record.agentId),
      mcpToken,
    }

    try {
      live.handle = options.spawnPty({
        file: agent.binPath,
        args: rArgs,
        cwd: record.cwd,
        env: {
          MIM_PORT: String(options.getMcpServerPort()),
          MIM_TOKEN: mcpToken,
        },
        onData: (chunk) => onData(live, chunk),
        onExit: (exitCode) => onExit(live, exitCode),
      })
    } catch (err) {
      revokeLiveMcpToken(live)
      throw err
    }

    active.set(sessionId, live)
    persist(record)
    if (!live.autoTitleAttempted) startAutoTitleTimer(live)
    const merged = withRuntime(record)
    emitEvent('session.started', merged)
    return { record: merged, ptyId: live.handle.ptyId }
  }

  function stop(sessionId: string): AgentSessionRuntime {
    const live = active.get(sessionId)
    if (!live) {
      const record = requireRecord(sessionId)
      // Stale record with no live pty (e.g. left over from a crash that
      // reconcile has not seen): transition to a terminal state directly.
      if (record.status === 'running') {
        record.status = 'stopped'
        record.endedAt = now().toISOString()
        persist(record)
        emitEvent('session.exited', { ...record })
      }
      return { ...record }
    }
    live.stopRequested = true
    clearIdleTimer(live)
    clearAutoTitleTimer(live)
    revokeLiveMcpToken(live)
    live.handle.kill()
    return withRuntime(live.record)
  }

  function stopAll(): void {
    for (const sessionId of [...active.keys()]) stop(sessionId)
  }

  function list(listOptions: { includeArchived?: boolean; archived?: boolean } = {}): AgentSessionRuntime[] {
    const records: AgentSessionRuntime[] = []
    for (const record of readAllRecords()) {
      const archived = record.archived === true
      if (listOptions.archived !== undefined && archived !== listOptions.archived) continue
      if (!listOptions.includeArchived && listOptions.archived === undefined && archived) continue
      records.push(withRuntime(record))
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  function get(sessionId: string, getOptions: { scrollback?: boolean } = {}): AgentSessionRuntime | null {
    const record = readRecord(sessionId)
    if (!record) return null
    const merged = withRuntime(record)
    if (getOptions.scrollback) {
      const path = scrollbackPath(sessionId)
      merged.scrollback = existsSync(path) ? readFileSync(path, 'utf-8') : ''
    }
    return merged
  }

  function rename(sessionId: string, title: string): AgentSessionRuntime {
    const record = requireRecord(sessionId)
    const trimmed = title.trim()
    if (!trimmed) throw new Error('Agent session title cannot be empty')
    record.title = trimmed
    persist(record)
    const merged = withRuntime(record)
    emitEvent('session.changed', merged)
    return merged
  }

  function archive(sessionId: string, archived = true): AgentSessionRuntime {
    const record = requireRecord(sessionId)
    record.archived = archived
    persist(record)
    const merged = withRuntime(record)
    emitEvent('session.changed', merged)
    return merged
  }

  function deleteSession(sessionId: string): { deleted: string } {
    if (active.has(sessionId)) throw new Error(`Cannot delete running agent session: ${sessionId}`)
    const record = readRecord(sessionId)
    if (!record) {
      const scrollback = scrollbackPath(sessionId)
      if (existsSync(scrollback)) unlinkSync(scrollback)
      return { deleted: sessionId }
    }
    unlinkSync(recordPath(sessionId))
    const scrollback = scrollbackPath(sessionId)
    if (existsSync(scrollback)) unlinkSync(scrollback)
    // The session field carries the deleted record so listeners prune by id.
    emitEvent('session.deleted', { ...record })
    return { deleted: sessionId }
  }

  function reconcileStaleSessions(): void {
    let records: AgentSessionRecord[]
    try {
      records = readAllRecords()
    } catch {
      return
    }
    for (const record of records) {
      if (record.status !== 'running') continue
      if (active.has(record.sessionId)) continue
      record.status = 'stopped'
      record.endedAt = now().toISOString()
      persist(record)
    }
  }

  function activeSessionCount(): number {
    return active.size
  }

  function revokeLiveMcpToken(live: LiveSession): void {
    if (!live.mcpToken) return
    options.revokeMcpToken(live.mcpToken)
    live.mcpToken = undefined
  }

  return { launch, resume, stop, stopAll, list, get, rename, archive, delete: deleteSession, reconcileStaleSessions, activeSessionCount }
}
