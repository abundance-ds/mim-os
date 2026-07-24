import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { atomicWriteJson } from '@main/atomicJson.js'
import {
  createAgentSessions,
  SCROLLBACK_MAX_BYTES,
  SCROLLBACK_KEEP_BYTES,
  cleanTitleHint,
  isTrivialTitle,
  extractCodexPrompt,
  extractGeminiPrompt,
  stripAnsi,
  type AgentSessionRecord,
  type AgentSessionsOptions,
} from '@main/agents/agentSessions.js'
import type { DetectedAgent } from '@main/agents/agentCatalog.js'
import { cliSessionsDir } from '@main/agents/agentCatalog.js'

const codex: DetectedAgent = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  args: [],
  installed: true,
  binPath: '/opt/homebrew/bin/codex',
}

const gemini: DetectedAgent = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  bin: 'gemini',
  args: [],
  installed: true,
  binPath: '/opt/homebrew/bin/gemini',
}

const pi: DetectedAgent = {
  id: 'pi',
  name: 'Pi',
  bin: 'pi',
  args: [],
  minimumVersion: '0.76.0',
  mimToolConnection: 'extension',
  extensionResource: 'pi/mim-extension.mjs',
  installed: true,
  binPath: '/opt/homebrew/bin/pi',
  version: '0.80.6',
  compatible: true,
}
import type { PtyHandle, PtySpawnOptions } from '@main/pty.js'

const claude: DetectedAgent = {
  id: 'claude-code',
  name: 'Claude Code',
  bin: 'claude',
  args: ['--verbose'],
  installed: true,
  binPath: '/opt/homebrew/bin/claude',
}

const codexMissing: DetectedAgent = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  args: [],
  installed: false,
}

interface FakePty {
  ptyId: number
  opts: PtySpawnOptions
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  data(chunk: string): void
  exit(code: number): void
}

interface SessionEvent {
  type: string
  session: AgentSessionRecord & { ptyId?: number; runtimeStatus?: string; titleHint?: string }
}

describe('agent sessions', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-agent-sessions-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const sessionsDir = () => join(dir, '.mim', 'agent-sessions')

  function makeHarness(overrides: Partial<AgentSessionsOptions> = {}) {
    const channels: string[] = []
    const events: SessionEvent[] = []
    const ptys: FakePty[] = []
    const mcpSessionIds: string[] = []
    const revokedMcpTokens: string[] = []
    let nextPtyId = 100
    const spawnPty = (opts: PtySpawnOptions): PtyHandle => {
      const fake: FakePty = {
        ptyId: nextPtyId++,
        opts,
        write: vi.fn(),
        resize: vi.fn(),
        // Real kills end the process with a non-zero exit; the stopped
        // classification must come from recorded intent, not the exit code.
        kill: vi.fn(() => fake.exit(1)),
        data: (chunk) => opts.onData?.(chunk),
        exit: (code) => opts.onExit?.(code),
      }
      ptys.push(fake)
      return { ptyId: fake.ptyId, write: fake.write, resize: fake.resize, kill: fake.kill }
    }
    const sessions = createAgentSessions({
      getWorkspacePath: () => dir,
      spawnPty,
      getMcpServerPort: () => 54321,
      createMcpToken: (sessionId) => {
        mcpSessionIds.push(sessionId)
        return `mcp-token-for-${sessionId}`
      },
      revokeMcpToken: (token) => {
        revokedMcpTokens.push(token)
      },
      emit: (channel, data) => {
        channels.push(channel)
        events.push(data as SessionEvent)
      },
      ...overrides,
    })
    return { sessions, events, channels, ptys, mcpSessionIds, revokedMcpTokens }
  }

  it('quarantines corrupt record files instead of failing list and get', () => {
    const { sessions, ptys } = makeHarness()
    sessions.launch(claude)
    ptys[0].exit(0)
    const corruptPath = join(sessionsDir(), 'broken.json')
    writeFileSync(corruptPath, '{ not json')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(sessions.list()).toHaveLength(1)
      expect(existsSync(corruptPath)).toBe(false)
      expect(existsSync(`${corruptPath}.corrupt`)).toBe(true)
      expect(error).toHaveBeenCalled()
      expect(sessions.get('broken')).toBeNull()
    } finally {
      error.mockRestore()
    }
  })

  it('documents the scrollback cap constants', () => {
    expect(SCROLLBACK_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(SCROLLBACK_KEEP_BYTES).toBe(1024 * 1024)
  })

  it('refuses to launch an agent that is not installed', () => {
    const { sessions, ptys } = makeHarness()
    expect(() => sessions.launch(codexMissing)).toThrow('Agent not installed: codex')
    expect(ptys).toHaveLength(0)
  })

  it('launch spawns the resolved binary in the workspace root and persists a running record', () => {
    const { sessions, events, channels, ptys, mcpSessionIds } = makeHarness()

    const { record, ptyId } = sessions.launch(claude)

    expect(ptys).toHaveLength(1)
    expect(ptys[0].opts.file).toBe('/opt/homebrew/bin/claude')
    expect(ptys[0].opts.args).toEqual(['--verbose'])
    expect(ptys[0].opts.cwd).toBe(dir)
    expect(ptys[0].opts.env).toEqual({
      MIM_PORT: '54321',
      MIM_TOKEN: `mcp-token-for-${record.sessionId}`,
    })
    expect(ptys[0].opts.shellIntegration).toBeUndefined()
    expect(mcpSessionIds).toEqual([record.sessionId])
    expect(ptyId).toBe(ptys[0].ptyId)

    expect(record.agentId).toBe('claude-code')
    expect(record.title).toBe('Claude Code')
    expect(record.command).toBe('/opt/homebrew/bin/claude --verbose')
    expect(record.cwd).toBe(dir)
    expect(record.status).toBe('running')
    expect(record.runtimeStatus).toBe('idle')
    expect(record.startedAt).toBeTruthy()
    expect(record.ptyId).toBe(ptyId)

    const onDisk = JSON.parse(readFileSync(join(sessionsDir(), `${record.sessionId}.json`), 'utf-8'))
    expect(onDisk.status).toBe('running')
    expect(onDisk.ptyId).toBeUndefined() // runtime state never persists

    expect(channels).toEqual(['agent:session-event'])
    expect(events[0]).toMatchObject({
      type: 'session.started',
      session: { sessionId: record.sessionId, status: 'running', runtimeStatus: 'idle' },
    })
    expect(sessions.activeSessionCount()).toBe(1)
  })

  it('launches Pi with the Mim session id and persists flags needed for exact resume', () => {
    const { sessions, ptys } = makeHarness({
      generateId: () => 'mim-pi-session',
      resolveAgentResource: () => '/bundled/pi/mim-extension.mjs',
    })

    const { record } = sessions.launch(pi, ['--model', 'openai/gpt-5'])

    expect(ptys[0].opts.args).toEqual([
      '--session-id',
      'mim-pi-session',
      '--model',
      'openai/gpt-5',
      '--extension',
      '/bundled/pi/mim-extension.mjs',
    ])
    expect(record.cliSessionId).toBe('mim-pi-session')
    expect(record.userArgs).toEqual(['--model', 'openai/gpt-5'])
    expect(record.command).toBe('/opt/homebrew/bin/pi --session-id mim-pi-session --model openai/gpt-5 --extension /bundled/pi/mim-extension.mjs')

    const onDisk = JSON.parse(readFileSync(join(sessionsDir(), 'mim-pi-session.json'), 'utf-8'))
    expect(onDisk.cliSessionId).toBe('mim-pi-session')
    expect(onDisk.userArgs).toEqual(['--model', 'openai/gpt-5'])
  })

  it('still launches Pi when the optional bundled extension cannot be resolved', () => {
    const { sessions, ptys } = makeHarness({
      generateId: () => 'mim-pi-session',
      resolveAgentResource: () => null,
    })

    sessions.launch(pi)

    expect(ptys[0].opts.args).toEqual(['--session-id', 'mim-pi-session'])
  })

  it('counters duplicate default titles', () => {
    const { sessions } = makeHarness()
    expect(sessions.launch(claude).record.title).toBe('Claude Code')
    expect(sessions.launch(claude).record.title).toBe('Claude Code 2')
    expect(sessions.launch(claude).record.title).toBe('Claude Code 3')
  })

  it('maps exit code 0 to done and persists the transition', () => {
    const { sessions, events, ptys } = makeHarness()
    const { record } = sessions.launch(claude)

    ptys[0].exit(0)

    const ended = sessions.get(record.sessionId)!
    expect(ended.status).toBe('done')
    expect(ended.exitCode).toBe(0)
    expect(ended.endedAt).toBeTruthy()
    expect(ended.ptyId).toBeUndefined()
    expect(ended.runtimeStatus).toBeUndefined()
    expect(sessions.activeSessionCount()).toBe(0)

    const onDisk = JSON.parse(readFileSync(join(sessionsDir(), `${record.sessionId}.json`), 'utf-8'))
    expect(onDisk.status).toBe('done')
    expect(events.at(-1)).toMatchObject({ type: 'session.exited', session: { status: 'done', exitCode: 0 } })
  })

  it('revokes the per-session MCP token when a live session exits or is stopped', () => {
    const { sessions, ptys, revokedMcpTokens } = makeHarness()
    const first = sessions.launch(claude).record

    ptys[0].exit(0)

    expect(revokedMcpTokens).toEqual([`mcp-token-for-${first.sessionId}`])

    const second = sessions.launch(claude).record
    sessions.stop(second.sessionId)

    expect(revokedMcpTokens).toEqual([
      `mcp-token-for-${first.sessionId}`,
      `mcp-token-for-${second.sessionId}`,
    ])
  })

  it('revokes the MCP token if pty spawn fails after token creation', () => {
    const { sessions, revokedMcpTokens } = makeHarness({
      spawnPty: () => {
        throw new Error('spawn failed')
      },
    })

    expect(() => sessions.launch(claude)).toThrow('spawn failed')
    expect(revokedMcpTokens).toHaveLength(1)
    expect(revokedMcpTokens[0]).toMatch(/^mcp-token-for-/)
    expect(sessions.activeSessionCount()).toBe(0)
  })

  it('maps non-zero exit codes to error', () => {
    const { sessions, ptys } = makeHarness()
    const { record } = sessions.launch(claude)

    ptys[0].exit(3)

    const ended = sessions.get(record.sessionId)!
    expect(ended.status).toBe('error')
    expect(ended.exitCode).toBe(3)
  })

  it('classifies stop() as stopped even though the process exits non-zero', () => {
    const { sessions, events, ptys } = makeHarness()
    const { record } = sessions.launch(claude)

    sessions.stop(record.sessionId)

    expect(ptys[0].kill).toHaveBeenCalledTimes(1)
    const ended = sessions.get(record.sessionId)!
    expect(ended.status).toBe('stopped')
    expect(ended.endedAt).toBeTruthy()
    expect(sessions.activeSessionCount()).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'session.exited', session: { status: 'stopped' } })
  })

  it('stops every live agent session during app shutdown', () => {
    const { sessions, ptys, revokedMcpTokens } = makeHarness()
    const first = sessions.launch(claude).record
    const second = sessions.launch(claude).record

    sessions.stopAll()

    expect(ptys.map(pty => pty.kill.mock.calls.length)).toEqual([1, 1])
    expect(sessions.activeSessionCount()).toBe(0)
    expect(sessions.get(first.sessionId)?.status).toBe('stopped')
    expect(sessions.get(second.sessionId)?.status).toBe('stopped')
    expect(revokedMcpTokens).toEqual([
      `mcp-token-for-${first.sessionId}`,
      `mcp-token-for-${second.sessionId}`,
    ])
  })

  it('stop on a stale running record (no live pty) transitions it to stopped', () => {
    const staleId = randomUUID()
    atomicWriteJson(join(sessionsDir(), `${staleId}.json`), {
      sessionId: staleId,
      agentId: 'claude-code',
      title: 'Claude Code',
      command: '/opt/homebrew/bin/claude',
      cwd: dir,
      status: 'running',
      startedAt: '2026-06-01T00:00:00.000Z',
    })
    const { sessions } = makeHarness()

    const record = sessions.stop(staleId)

    expect(record.status).toBe('stopped')
    expect(record.endedAt).toBeTruthy()
    const onDisk = JSON.parse(readFileSync(join(sessionsDir(), `${staleId}.json`), 'utf-8'))
    expect(onDisk.status).toBe('stopped')
  })

  it('stop on an unknown session throws', () => {
    const { sessions } = makeHarness()
    expect(() => sessions.stop('nope')).toThrow('Agent session not found: nope')
  })

  it('reconcileStaleSessions marks persisted running records as stopped', () => {
    const staleId = randomUUID()
    atomicWriteJson(join(sessionsDir(), `${staleId}.json`), {
      sessionId: staleId,
      agentId: 'claude-code',
      title: 'Claude Code',
      command: '/opt/homebrew/bin/claude',
      cwd: dir,
      status: 'running',
      startedAt: '2026-06-01T00:00:00.000Z',
    })
    const { sessions, ptys } = makeHarness()
    const live = sessions.launch(claude)

    sessions.reconcileStaleSessions()

    expect(sessions.get(staleId)!.status).toBe('stopped')
    expect(sessions.get(staleId)!.endedAt).toBeTruthy()
    // Live sessions are untouched
    expect(sessions.get(live.record.sessionId)!.status).toBe('running')
    ptys[0].exit(0)
  })

  it('appends raw pty output to the scrollback file and returns it from get', () => {
    const { sessions, ptys } = makeHarness()
    const { record } = sessions.launch(claude)

    ptys[0].data('hello ')
    ptys[0].data('world')
    ptys[0].exit(0)

    const withScrollback = sessions.get(record.sessionId, { scrollback: true })!
    expect(withScrollback.scrollback).toBe('hello world')
    expect(sessions.get(record.sessionId)!.scrollback).toBeUndefined()
    expect(readFileSync(join(sessionsDir(), `${record.sessionId}.scrollback`), 'utf-8')).toBe('hello world')
  })

  it('truncates scrollback from the front once it exceeds the cap', () => {
    const { sessions, ptys } = makeHarness({ scrollbackMaxBytes: 100, scrollbackKeepBytes: 40 })
    const { record } = sessions.launch(claude)

    ptys[0].data('a'.repeat(60))
    expect(statSync(join(sessionsDir(), `${record.sessionId}.scrollback`)).size).toBe(60)

    ptys[0].data('b'.repeat(60)) // 120 > 100 → rewrite keeping the last 40 bytes
    expect(sessions.get(record.sessionId, { scrollback: true })!.scrollback).toBe('b'.repeat(40))

    ptys[0].data('c'.repeat(10))
    expect(sessions.get(record.sessionId, { scrollback: true })!.scrollback).toBe('b'.repeat(40) + 'c'.repeat(10))
  })

  it('emits session.status only when runtime status or title hint changes', () => {
    const { sessions, events, ptys } = makeHarness()
    sessions.launch(claude)
    events.length = 0

    ptys[0].data('plain output') // startup output stays idle during fallback grace
    expect(events).toHaveLength(0)

    ptys[0].data('more plain output') // no duplicate working event
    expect(events).toHaveLength(0)

    ptys[0].data('\x07') // BEL → needs-input
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'needs-input' } })

    ptys[0].data('typed reply') // back to working
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'working' } })

    ptys[0].data('more of the same') // still working → no event
    expect(events).toHaveLength(2)
  })

  it('emits session.status with idle after the silence threshold', () => {
    vi.useFakeTimers()
    try {
      const { sessions, events, ptys } = makeHarness({ idleThresholdMs: 100 })
      sessions.launch(claude)
      events.length = 0

      ptys[0].data('\x07') // BEL → needs-input
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'needs-input' } })

      vi.advanceTimersByTime(200) // past threshold + 50ms timer delay
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'idle' } })

      ptys[0].data('back to work') // resets to working
      expect(events).toHaveLength(3)
      expect(events[2]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'working' } })

      ptys[0].exit(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits session.status with done then idle for OSC 9 progress signals', () => {
    vi.useFakeTimers()
    try {
      const { sessions, events, ptys } = makeHarness({ idleThresholdMs: 100 })
      sessions.launch(claude)
      events.length = 0

      // Boot done → enters progress mode, status changes from working to done
      ptys[0].data('\x1b]9;4;0;\x07')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'done' } })

      // Start work → back to working
      ptys[0].data('\x1b]9;4;3;\x07')
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'working' } })

      // Task done → done
      ptys[0].data('\x1b]9;4;0;\x07')
      expect(events).toHaveLength(3)
      expect(events[2]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'done' } })

      // After threshold → idle
      vi.advanceTimersByTime(200)
      expect(events).toHaveLength(4)
      expect(events[3]).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'idle' } })

      ptys[0].exit(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits needs-input when the title spinner stops (Codex/Gemini pattern)', () => {
    const { sessions, events, ptys } = makeHarness()
    sessions.launch(claude)
    events.length = 0

    // Title gains Braille prefix → working (via title spinner detection)
    ptys[0].data('\x1b]0;⠴ tmp\x07')
    expect(events.at(-1)).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'working' } })

    // Title loses Braille prefix → needs-input
    ptys[0].data('\x1b]0;tmp\x07')
    expect(events.at(-1)).toMatchObject({ type: 'session.status', session: { runtimeStatus: 'needs-input' } })

    ptys[0].exit(0)
  })

  it('keeps a Codex Action Required title at needs-input until activity resumes', () => {
    vi.useFakeTimers()
    try {
      const { sessions, events, ptys } = makeHarness({ idleThresholdMs: 100 })
      const { record } = sessions.launch(codex)
      events.length = 0

      ptys[0].data('\x1b]0;⣴ Working | mim-os\x07')
      ptys[0].data('\x1b]0;[ ! ] Action Required | mim-os\x07')
      expect(events.at(-1)).toMatchObject({
        type: 'session.status',
        session: { runtimeStatus: 'needs-input' },
      })

      vi.advanceTimersByTime(200)
      expect(sessions.get(record.sessionId)!.runtimeStatus).toBe('needs-input')
      expect(events.some(event => event.session.runtimeStatus === 'idle')).toBe(false)

      ptys[0].data('\x1b]0;⢦ Working | mim-os\x07')
      expect(events.at(-1)).toMatchObject({
        type: 'session.status',
        session: { runtimeStatus: 'working' },
      })

      ptys[0].exit(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists titleHint changes and surfaces them on the merged record', () => {
    const { sessions, events, ptys } = makeHarness()
    const { record } = sessions.launch(claude)
    events.length = 0

    ptys[0].data('\x1b]0;Refactoring auth\x07')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'session.status', session: { titleHint: 'Refactoring auth' } })
    expect(sessions.get(record.sessionId)!.titleHint).toBe('Refactoring auth')
    const onDisk = JSON.parse(readFileSync(join(sessionsDir(), `${record.sessionId}.json`), 'utf-8'))
    expect(onDisk.titleHint).toBe('Refactoring auth')
  })

  it('merges live runtime state into list and get', () => {
    const { sessions, ptys } = makeHarness()
    const { record, ptyId } = sessions.launch(claude)

    ptys[0].data('\x07')
    const listed = sessions.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].ptyId).toBe(ptyId)
    expect(listed[0].runtimeStatus).toBe('needs-input')
    expect(sessions.get(record.sessionId)!.runtimeStatus).toBe('needs-input')

    ptys[0].exit(0)
    expect(sessions.list()[0].ptyId).toBeUndefined()
    expect(sessions.list()[0].runtimeStatus).toBeUndefined()
  })

  it('renames sessions, persists, and emits session.changed', () => {
    const { sessions, events, ptys } = makeHarness()
    const { record } = sessions.launch(claude)
    ptys[0].exit(0)
    events.length = 0

    const renamed = sessions.rename(record.sessionId, '  Auth refactor  ')

    expect(renamed.title).toBe('Auth refactor')
    expect(events.at(-1)).toMatchObject({ type: 'session.changed', session: { title: 'Auth refactor' } })
    const onDisk = JSON.parse(readFileSync(join(sessionsDir(), `${record.sessionId}.json`), 'utf-8'))
    expect(onDisk.title).toBe('Auth refactor')
    expect(() => sessions.rename(record.sessionId, '   ')).toThrow('Agent session title cannot be empty')
    expect(() => sessions.rename('nope', 'x')).toThrow('Agent session not found: nope')
  })

  it('archives, restores, and filters sessions in list', () => {
    const { sessions, ptys } = makeHarness()
    const { record } = sessions.launch(claude)
    ptys[0].exit(0)

    expect(sessions.archive(record.sessionId).archived).toBe(true)
    expect(sessions.list()).toHaveLength(0)
    expect(sessions.list({ archived: true }).map(s => s.sessionId)).toEqual([record.sessionId])
    expect(sessions.list({ includeArchived: true })).toHaveLength(1)

    expect(sessions.archive(record.sessionId, false).archived).toBe(false)
    expect(sessions.list()).toHaveLength(1)
  })

  it('deletes the record and the scrollback file together, then treats repeat deletes as done', () => {
    const { sessions, ptys } = makeHarness()
    const { record } = sessions.launch(claude)
    ptys[0].data('output')

    expect(() => sessions.delete(record.sessionId)).toThrow(`Cannot delete running agent session: ${record.sessionId}`)

    ptys[0].exit(0)
    expect(sessions.delete(record.sessionId)).toEqual({ deleted: record.sessionId })
    expect(sessions.get(record.sessionId)).toBeNull()
    expect(existsSync(join(sessionsDir(), `${record.sessionId}.json`))).toBe(false)
    expect(existsSync(join(sessionsDir(), `${record.sessionId}.scrollback`))).toBe(false)
    expect(sessions.delete(record.sessionId)).toEqual({ deleted: record.sessionId })
  })

  it('emits a deleted event so renderers remove the stale aggregate row', () => {
    const { sessions, events, ptys } = makeHarness()
    const { record } = sessions.launch(claude)
    ptys[0].exit(0)
    events.length = 0

    sessions.delete(record.sessionId)

    expect(events.at(-1)).toMatchObject({
      type: 'session.deleted',
      session: { sessionId: record.sessionId },
    })
  })

  it('removes orphan scrollback when deleting an already-missing record', () => {
    const { sessions } = makeHarness()
    const sessionId = 'orphan-session'
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(join(sessionsDir(), `${sessionId}.scrollback`), 'orphan output')

    expect(sessions.delete(sessionId)).toEqual({ deleted: sessionId })

    expect(existsSync(join(sessionsDir(), `${sessionId}.scrollback`))).toBe(false)
  })

  it('lists sessions newest first', () => {
    let tick = 0
    const { sessions, ptys } = makeHarness({
      now: () => new Date(Date.UTC(2026, 5, 12, 0, 0, tick++)),
    })
    const first = sessions.launch(claude)
    const second = sessions.launch(claude)

    expect(sessions.list().map(s => s.sessionId)).toEqual([second.record.sessionId, first.record.sessionId])
    ptys.forEach(p => p.exit(0))
  })

  it('counts only live sessions', () => {
    const { sessions, ptys } = makeHarness()
    sessions.launch(claude)
    sessions.launch(claude)
    expect(sessions.activeSessionCount()).toBe(2)
    ptys[0].exit(0)
    expect(sessions.activeSessionCount()).toBe(1)
    ptys[1].exit(0)
    expect(sessions.activeSessionCount()).toBe(0)
  })

  it('throws when no workspace is open', () => {
    const { sessions } = makeHarness({ getWorkspacePath: () => null })
    expect(() => sessions.launch(claude)).toThrow('No workspace open')
  })

  it('detects Claude Code cliSessionId from new .jsonl file on first pty output', () => {
    vi.stubEnv('HOME', dir)
    const projectDir = cliSessionsDir('claude-code', dir)!
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'existing-session.jsonl'), '')

    const { sessions, ptys } = makeHarness()
    const { record } = sessions.launch(claude)

    writeFileSync(join(projectDir, 'new-claude-session.jsonl'), '')
    ptys[0].data('hello')

    expect(sessions.get(record.sessionId)!.cliSessionId).toBe('new-claude-session')
    ptys[0].exit(0)
    vi.unstubAllEnvs()
  })

  it('detects Codex cliSessionId by extracting UUID from rollout filename', () => {
    vi.stubEnv('HOME', dir)
    const codexDir = join(dir, '.codex', 'sessions', '2026', '01', '01')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'rollout-2026-01-01T00-00-00-aaaa1111-bbbb-cccc-dddd-eeeeffffaaaa.jsonl'), '')

    const { sessions, ptys } = makeHarness({ now: () => new Date('2026-01-01T00:00:00Z') })
    const { record } = sessions.launch(codex)

    writeFileSync(join(codexDir, 'rollout-2026-01-01T00-05-00-019f0ec9-9bf9-73f0-8d38-9f98d67a8668.jsonl'), '')
    ptys[0].data('hello')

    expect(sessions.get(record.sessionId)!.cliSessionId).toBe('019f0ec9-9bf9-73f0-8d38-9f98d67a8668')
    ptys[0].exit(0)
    vi.unstubAllEnvs()
  })

  it('detects Gemini cliSessionId from new session file', () => {
    vi.stubEnv('HOME', dir)
    const geminiDir = cliSessionsDir('gemini-cli', dir)!
    mkdirSync(geminiDir, { recursive: true })
    writeFileSync(join(geminiDir, 'session-2026-06-24T16-04-3ec1763e.jsonl'), '')

    const { sessions, ptys } = makeHarness()
    const { record } = sessions.launch(gemini)

    writeFileSync(join(geminiDir, 'session-2026-06-25T13-45-19cc6840.jsonl'), '')
    ptys[0].data('hello')

    expect(sessions.get(record.sessionId)!.cliSessionId).toBe('session-2026-06-25T13-45-19cc6840')
    ptys[0].exit(0)
    vi.unstubAllEnvs()
  })

  describe('resume', () => {
    it('resumes Pi with the same exact id and original custom flags', () => {
      const { sessions, ptys } = makeHarness({
        generateId: () => 'mim-pi-session',
        resolveAgentResource: () => '/bundled/pi/mim-extension.mjs',
      })
      const { record: original } = sessions.launch(pi, ['--model', 'openai/gpt-5'])
      ptys[0].exit(0)

      const { record: resumed } = sessions.resume(original.sessionId, pi)

      expect(ptys[1].opts.args).toEqual([
        '--session-id',
        'mim-pi-session',
        '--model',
        'openai/gpt-5',
        '--extension',
        '/bundled/pi/mim-extension.mjs',
      ])
      expect(resumed.command).toBe('/opt/homebrew/bin/pi --session-id mim-pi-session --model openai/gpt-5 --extension /bundled/pi/mim-extension.mjs')
    })

    it('spawns Claude Code with --resume <cliSessionId> when detected', () => {
      vi.stubEnv('HOME', dir)
      const projectDir = cliSessionsDir('claude-code', dir)!
      mkdirSync(projectDir, { recursive: true })

      const { sessions, events, ptys, mcpSessionIds } = makeHarness()
      const { record: original } = sessions.launch(claude)
      writeFileSync(join(projectDir, 'cc-real-id.jsonl'), '')
      ptys[0].data('output')
      ptys[0].exit(0)
      events.length = 0

      expect(sessions.get(original.sessionId)!.cliSessionId).toBe('cc-real-id')

      const { record: resumed, ptyId } = sessions.resume(original.sessionId, claude)

      expect(resumed.sessionId).toBe(original.sessionId)
      expect(resumed.status).toBe('running')
      expect(ptys[1].opts.args).toEqual(['--resume', 'cc-real-id'])
      expect(resumed.command).toBe('/opt/homebrew/bin/claude --resume cc-real-id')

      expect(mcpSessionIds).toContain(original.sessionId)
      expect(events[0]).toMatchObject({ type: 'session.started', session: { sessionId: original.sessionId, status: 'running' } })
      expect(sessions.activeSessionCount()).toBe(1)

      ptys[1].exit(0)
      vi.unstubAllEnvs()
    })

    it('falls back to --continue for Claude Code when cliSessionId is not detected', () => {
      const { sessions, ptys } = makeHarness()
      const { record: original } = sessions.launch(claude)
      ptys[0].exit(0)

      const { record: resumed } = sessions.resume(original.sessionId, claude)

      expect(ptys[1].opts.args).toEqual(['--continue'])
      expect(resumed.command).toBe('/opt/homebrew/bin/claude --continue')
      ptys[1].exit(0)
    })

    it('spawns Codex with resume <uuid> when cliSessionId detected', () => {
      vi.stubEnv('HOME', dir)
      const codexDir = join(dir, '.codex', 'sessions', '2026', '01', '01')
      mkdirSync(codexDir, { recursive: true })

      const { sessions, ptys } = makeHarness({ now: () => new Date('2026-01-01T00:00:00Z') })
      const { record: original } = sessions.launch(codex)
      writeFileSync(join(codexDir, 'rollout-2026-01-01T00-05-00-abcd1234-ef56-7890-abcd-ef1234567890.jsonl'), '')
      ptys[0].data('output')
      ptys[0].exit(0)

      const { record: resumed } = sessions.resume(original.sessionId, codex)

      expect(ptys[1].opts.args).toEqual(['resume', 'abcd1234-ef56-7890-abcd-ef1234567890'])
      expect(resumed.command).toBe('/opt/homebrew/bin/codex resume abcd1234-ef56-7890-abcd-ef1234567890')
      ptys[1].exit(0)
      vi.unstubAllEnvs()
    })

    it('spawns Gemini with --session-file when cliSessionId detected', () => {
      vi.stubEnv('HOME', dir)
      const geminiDir = cliSessionsDir('gemini-cli', dir)!
      mkdirSync(geminiDir, { recursive: true })

      const { sessions, ptys } = makeHarness()
      const { record: original } = sessions.launch(gemini)
      writeFileSync(join(geminiDir, 'session-2026-06-25T13-45-19cc6840.jsonl'), '')
      ptys[0].data('output')
      ptys[0].exit(0)

      const { record: resumed } = sessions.resume(original.sessionId, gemini)

      expect(ptys[1].opts.args).toEqual(['--session-file', join(geminiDir, 'session-2026-06-25T13-45-19cc6840.jsonl')])
      ptys[1].exit(0)
      vi.unstubAllEnvs()
    })

    it('appends new output to existing scrollback', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)
      ptys[0].data('before resume ')
      ptys[0].exit(0)

      sessions.resume(record.sessionId, claude)
      ptys[1].data('after resume')
      ptys[1].exit(0)

      const withScrollback = sessions.get(record.sessionId, { scrollback: true })!
      expect(withScrollback.scrollback).toBe('before resume after resume')
    })

    it('throws on a running session', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)

      expect(() => sessions.resume(record.sessionId, claude)).toThrow('Agent session is already running')

      ptys[0].exit(0)
    })

    it('throws on a non-existent session', () => {
      const { sessions } = makeHarness()
      expect(() => sessions.resume('nonexistent', claude)).toThrow('Agent session not found: nonexistent')
    })

    it('un-archives an archived session on resume', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)
      ptys[0].exit(0)
      sessions.archive(record.sessionId, true)

      const { record: resumed } = sessions.resume(record.sessionId, claude)

      expect(resumed.archived).toBe(false)
      ptys[1].exit(0)
    })

    it('revokes MCP token on spawn failure', () => {
      let spawnCount = 0
      const { sessions, revokedMcpTokens, ptys } = makeHarness({
        spawnPty: (opts) => {
          spawnCount++
          if (spawnCount === 2) throw new Error('spawn failed')
          const fake = {
            ptyId: 100,
            write: vi.fn(),
            resize: vi.fn(),
            kill: vi.fn(() => opts.onExit?.(1)),
          }
          ptys.push({ ...fake, opts, data: (c: string) => opts.onData?.(c), exit: (code: number) => opts.onExit?.(code) } as unknown as FakePty)
          return { ptyId: fake.ptyId, write: fake.write, resize: fake.resize, kill: fake.kill }
        },
      })
      const { record } = sessions.launch(claude)
      ptys[0].exit(0)

      expect(() => sessions.resume(record.sessionId, claude)).toThrow('spawn failed')
      expect(revokedMcpTokens.at(-1)).toMatch(/^mcp-token-for-/)
      expect(sessions.activeSessionCount()).toBe(0)

      const onDisk = JSON.parse(readFileSync(join(sessionsDir(), `${record.sessionId}.json`), 'utf-8'))
      expect(onDisk.status).toBe('done')
    })

    it('works on interrupted, stopped, and error sessions', () => {
      const { sessions, ptys } = makeHarness()

      const s1 = sessions.launch(claude)
      ptys[0].exit(0)
      expect(sessions.resume(s1.record.sessionId, claude).record.status).toBe('running')
      ptys[1].exit(0)

      const s2 = sessions.launch(claude)
      sessions.stop(s2.record.sessionId)
      expect(sessions.resume(s2.record.sessionId, claude).record.status).toBe('running')
      ptys[3].exit(0)

      const s3 = sessions.launch(claude)
      ptys[4].exit(1)
      expect(sessions.resume(s3.record.sessionId, claude).record.status).toBe('running')
      ptys[5].exit(0)
    })

    it('refuses to resume an uninstalled agent', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)
      ptys[0].exit(0)

      const uninstalled: DetectedAgent = { ...claude, installed: false, binPath: undefined }
      expect(() => sessions.resume(record.sessionId, uninstalled)).toThrow('Agent not installed')
    })
  })

  describe('auto-title', () => {
    it('assigns title from Claude Code titleHint when first spinner prefix appears', () => {
      const { sessions, events, ptys } = makeHarness()
      const { record } = sessions.launch(claude)
      events.length = 0

      // Boot title (no spinner) — title stays default
      ptys[0].data('\x1b]0;✳ Claude Code\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('Claude Code')

      // Working title with Braille spinner — triggers auto-title
      ptys[0].data('\x1b]0;⠂ Refactoring the auth module\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('Refactoring the auth module')

      const changed = events.find(e => e.type === 'session.changed')
      expect(changed).toBeTruthy()
      expect(changed!.session.title).toBe('Refactoring the auth module')

      ptys[0].exit(0)
    })

    it('skips Codex composer placeholders when extracting the submitted prompt', () => {
      const { sessions, events, ptys } = makeHarness()
      const { record } = sessions.launch(codex)
      const cwdBase = basename(dir)
      events.length = 0

      // Codex renders rotating examples after the same › marker used for the
      // submitted prompt. The placeholder appears first in raw scrollback.
      ptys[0].data('╭──────╮\n│ Codex │\n╰──────╯\n')
      ptys[0].data('› Improve documentation in @filename gpt-5.5 xhigh · ~/project\n')
      ptys[0].data('› Prepare the Thermo Fisher meeting brief gpt-5.5 xhigh · ~/project\n')

      // Spinner title with cwd basename triggers auto-title; titleHint is
      // trivial (matches cwd), so scrollback extraction kicks in
      ptys[0].data(`\x1b]0;⠴ ${cwdBase}\x07`)

      const session = sessions.get(record.sessionId)!
      expect(session.title).toBe('Prepare the Thermo Fisher meeting brief')

      ptys[0].exit(0)
    })

    it('keeps the default Codex title through startup until a submitted prompt appears', () => {
      vi.useFakeTimers()
      try {
        const generateTitle = vi.fn().mockResolvedValue('Commit summary')
        const { sessions, ptys } = makeHarness({ generateTitle })
        const { record } = sessions.launch(codex)
        const cwdBase = basename(dir)

        // Codex renders a composer example and emits working spinner titles
        // while MCP servers are still starting, before the user submits text.
        ptys[0].data('› Summarize recent commits gpt-5.5 xhigh · ~/project\n')
        ptys[0].data(`\x1b]0;⠸ ${cwdBase}\x07`)

        expect(generateTitle).not.toHaveBeenCalled()
        expect(sessions.get(record.sessionId)!.title).toBe('Codex')

        // Startup titles are not task evidence either, even if their text
        // would otherwise look descriptive.
        ptys[0].data('\x1b]0;⠼ Starting MCP servers\x07')
        expect(generateTitle).not.toHaveBeenCalled()
        expect(sessions.get(record.sessionId)!.title).toBe('Codex')

        // The launch timer must also leave this attempt retryable.
        vi.advanceTimersByTime(15100)
        expect(generateTitle).not.toHaveBeenCalled()
        expect(sessions.get(record.sessionId)!.title).toBe('Codex')

        // A later spinner frame retries after the actual submitted prompt.
        ptys[0].data('› Diagnose Codex update failure gpt-5.5 xhigh · ~/project\n')
        ptys[0].data(`\x1b]0;⠴ ${cwdBase}\x07`)

        expect(sessions.get(record.sessionId)!.title).toBe('Diagnose Codex update failure')

        ptys[0].exit(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('extracts title from Gemini CLI scrollback keystroke accumulation', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(gemini)

      // Boot
      ptys[0].data('\x1b]0;◇  Ready (project)\x07')
      ptys[0].data('> Type your message or @path/to/file\n')

      // User types (keystroke redraws)
      ptys[0].data('> f\n> fi\n> fix\n> fix t\n> fix the\n> fix the login bug\n')

      // Working spinner triggers auto-title
      ptys[0].data('\x1b]0;✦  Working… (project)\x07')

      expect(sessions.get(record.sessionId)!.title).toBe('fix the login bug')

      ptys[0].exit(0)
    })

    it('does not auto-title when the user has manually renamed', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)

      sessions.rename(record.sessionId, 'My Custom Name')

      // Spinner title arrives — but title was manually set
      ptys[0].data('\x1b]0;⠂ Refactoring auth\x07')

      expect(sessions.get(record.sessionId)!.title).toBe('My Custom Name')

      ptys[0].exit(0)
    })

    it('does not re-title on resume when title was already set', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)

      // First run: auto-title fires
      ptys[0].data('\x1b]0;⠂ Fix the auth bug\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('Fix the auth bug')
      ptys[0].exit(0)

      // Resume: new spinner arrives but title is already non-default
      sessions.resume(record.sessionId, claude)
      ptys[1].data('\x1b]0;⠂ Continuing work\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('Fix the auth bug')

      ptys[1].exit(0)
    })

    it('keeps default title when agent boots but user never gives a task', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)

      // Only boot title (✳ prefix is NOT a spinner)
      ptys[0].data('\x1b]0;✳ Claude Code\x07')
      ptys[0].data('\x1b]9;4;0;\x07')
      ptys[0].data('Welcome to Claude Code\n')

      expect(sessions.get(record.sessionId)!.title).toBe('Claude Code')

      ptys[0].exit(0)
    })

    it('fires only once per session even with multiple spinner titles', () => {
      const { sessions, events, ptys } = makeHarness()
      const { record } = sessions.launch(claude)
      events.length = 0

      ptys[0].data('\x1b]0;⠂ First task\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('First task')

      // Second spinner title — should NOT overwrite
      ptys[0].data('\x1b]0;⠂ Second task\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('First task')

      ptys[0].exit(0)
    })

    it('assigns title from timer fallback when no spinner appears', () => {
      vi.useFakeTimers()
      try {
        const { sessions, ptys } = makeHarness()
        const { record } = sessions.launch(gemini)

        // Boot — no spinner, just ◇ Ready
        ptys[0].data('\x1b]0;◇  Ready (project)\x07')
        ptys[0].data('> Type your message or @path/to/file\n')
        ptys[0].data('> f\n> fi\n> fix\n> fix the\n> fix the login bug\n')
        // Gemini responds without ever emitting ✦ spinner
        ptys[0].data('Looking at the login flow...\n')

        expect(sessions.get(record.sessionId)!.title).toBe('Gemini CLI')

        // After 15s, timer fires and extracts from scrollback
        vi.advanceTimersByTime(15100)
        expect(sessions.get(record.sessionId)!.title).toBe('fix the login bug')

        ptys[0].exit(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('cancels auto-title timer when spinner-based title succeeds first', () => {
      vi.useFakeTimers()
      try {
        const { sessions, ptys } = makeHarness()
        const { record } = sessions.launch(claude)

        // Spinner title succeeds at 2s
        vi.advanceTimersByTime(2000)
        ptys[0].data('\x1b]0;⠂ Fix auth\x07')
        expect(sessions.get(record.sessionId)!.title).toBe('Fix auth')

        // Timer at 15s should NOT overwrite
        vi.advanceTimersByTime(14000)
        expect(sessions.get(record.sessionId)!.title).toBe('Fix auth')

        ptys[0].exit(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('retries when the first spinner title is just the agent name', () => {
      const { sessions, ptys } = makeHarness()
      const { record } = sessions.launch(claude)

      // First spinner: just "Claude Code" (trivial) — should NOT set title yet
      ptys[0].data('\x1b]0;⠂ Claude Code\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('Claude Code')

      // Second spinner: real task description — NOW it sets the title
      ptys[0].data('\x1b]0;⠐ Fix the auth module\x07')
      expect(sessions.get(record.sessionId)!.title).toBe('Fix the auth module')

      ptys[0].exit(0)
    })

    it('calls generateTitle callback when heuristic extraction fails', async () => {
      const generateTitle = vi.fn().mockResolvedValue('LLM Generated Title')
      const { sessions, ptys } = makeHarness({ generateTitle })
      const { record } = sessions.launch(gemini)
      const cwdBase = basename(dir)

      // Boot noise only — no prompt in scrollback
      ptys[0].data('boot noise without any prompt marker\n')

      // Spinner with cwd basename triggers auto-title; titleHint is trivial,
      // scrollback has no prompt → falls through to generateTitle
      ptys[0].data(`\x1b]0;✦  Working… (${cwdBase})\x07`)

      expect(generateTitle).toHaveBeenCalledTimes(1)
      expect(typeof generateTitle.mock.calls[0][0]).toBe('string')

      // Wait for the async LLM callback
      await vi.waitFor(() => {
        expect(sessions.get(record.sessionId)!.title).toBe('LLM Generated Title')
      })

      ptys[0].exit(0)
    })

    it('does not update title from LLM if user renamed during the async call', async () => {
      let resolveTitle: (v: string | null) => void
      const generateTitle = vi.fn().mockReturnValue(new Promise<string | null>(r => { resolveTitle = r }))
      const { sessions, ptys } = makeHarness({ generateTitle })
      const { record } = sessions.launch(gemini)
      const cwdBase = basename(dir)

      ptys[0].data('no prompt\n')
      ptys[0].data(`\x1b]0;✦  Working… (${cwdBase})\x07`)

      expect(generateTitle).toHaveBeenCalledTimes(1)

      // User renames while LLM is in flight
      sessions.rename(record.sessionId, 'User Renamed')

      // LLM resolves — but should NOT overwrite user's rename
      resolveTitle!('LLM Title')
      await new Promise(r => setTimeout(r, 10))

      expect(sessions.get(record.sessionId)!.title).toBe('User Renamed')

      ptys[0].exit(0)
    })
  })

  describe('auto-title extraction functions', () => {
    it('cleanTitleHint strips indicator chars', () => {
      expect(cleanTitleHint('✳ Claude Code')).toBe('Claude Code')
      expect(cleanTitleHint('⠂ Refactoring auth')).toBe('Refactoring auth')
      expect(cleanTitleHint('◇  Ready (tmp)')).toBe('Ready (tmp)')
      expect(cleanTitleHint('✦  Working… (tmp)')).toBe('Working… (tmp)')
      expect(cleanTitleHint('⠴⠦⠧ spinning')).toBe('spinning')
      expect(cleanTitleHint('')).toBe('')
      expect(cleanTitleHint(undefined)).toBe('')
      expect(cleanTitleHint('plain text')).toBe('plain text')
    })

    it('isTrivialTitle rejects agent names, cwd basenames, and generic status', () => {
      expect(isTrivialTitle('Claude Code')).toBe(true)
      expect(isTrivialTitle('Codex')).toBe(true)
      expect(isTrivialTitle('Gemini CLI')).toBe(true)
      expect(isTrivialTitle('tmp', '/Users/test/tmp')).toBe(true)
      expect(isTrivialTitle('mim-apps', '/Users/test/mim-apps')).toBe(true)
      expect(isTrivialTitle('Ready (mim-packages)', '/Users/test/mim-packages')).toBe(true)
      expect(isTrivialTitle('Working… (project)', '/Users/test/project')).toBe(true)
      expect(isTrivialTitle('Ready')).toBe(true)
      expect(isTrivialTitle('')).toBe(true)
      expect(isTrivialTitle('ab')).toBe(true)
      expect(isTrivialTitle('Refactoring auth')).toBe(false)
      expect(isTrivialTitle('Fix the login button')).toBe(false)
    })

    it('extractCodexPrompt finds the prompt and strips model/dir suffix', () => {
      expect(extractCodexPrompt('› Improve docs gpt-5.5 xhigh · ~/app')).toBe('Improve docs')
      expect(extractCodexPrompt('› fix the bug')).toBe('fix the bug')
      expect(extractCodexPrompt('› Fix auth gpt-5.5 xhigh · ~/f› Fix auth gpt-5.5 xhigh · ~/f')).toBe('Fix auth')
      expect(extractCodexPrompt('› 1. Update now› 2. Skip› Fix it gpt-5.5 default · ~/f')).toBe('Fix it')
      expect(extractCodexPrompt('no marker at all')).toBeNull()
      expect(extractCodexPrompt('╭── boot chrome ──╮')).toBeNull()
    })

    it('extractCodexPrompt ignores rotating composer examples', () => {
      const scrollback = [
        '› Explain this codebase gpt-5.5 xhigh · ~/app',
        '› Summarize recent commits gpt-5.5 xhigh · ~/app',
        '› Implement {feature} gpt-5.5 xhigh · ~/app',
        '› Find and fix a bug in @filename gpt-5.5 xhigh · ~/app',
        '› Write tests for @filename gpt-5.5 xhigh · ~/app',
        '› Improve documentation in @filename gpt-5.5 xhigh · ~/app',
        '› Run /review on my current changes gpt-5.5 xhigh · ~/app',
        '› Use /skills to list available skills gpt-5.5 xhigh · ~/app',
        '› Check recently modified functions for compatibility gpt-5.5 xhigh · ~/app',
        '› How many files have been modified? gpt-5.5 xhigh · ~/app',
        '› Will this algorithm scale well? gpt-5.5 xhigh · ~/app',
        '› Prepare the quarterly research review gpt-5.5 xhigh · ~/app',
      ].join('\n')

      expect(extractCodexPrompt(scrollback)).toBe('Prepare the quarterly research review')
      expect(extractCodexPrompt('› Find and fix a bug in @filename gpt-5.5 xhigh · ~/app')).toBeNull()
    })

    it('extractGeminiPrompt finds the longest typed prompt', () => {
      expect(extractGeminiPrompt('> s\n> sa\n> say\n> say hi')).toBe('say hi')
      expect(extractGeminiPrompt('> Type your message\n> hello world')).toBe('hello world')
      expect(extractGeminiPrompt('> Type your message or @path/to/file')).toBeNull()
      expect(extractGeminiPrompt('no prompt markers')).toBeNull()
    })

    it('stripAnsi removes CSI, OSC, and DEC private mode sequences', () => {
      expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green')
      expect(stripAnsi('\x1b]0;title\x07')).toBe('')
      expect(stripAnsi('\x1b[>4;2m\x1b[>0q')).toBe('')
      expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden')
      expect(stripAnsi('plain text')).toBe('plain text')
      expect(stripAnsi('\x1b]777;notify;Agent;msg\x07')).toBe('')
    })
  })
})
