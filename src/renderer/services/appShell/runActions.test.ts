import { describe, expect, it, vi } from 'vitest'
import {
  createRunActions,
  type RunActionsDeps,
} from './runActions.js'
import type { AgentSessionRuntime, PackageRunRecord } from '../../stores/runs.js'
import type { WorkEntry } from '../workbench/entries.js'

function makePackageRun(overrides: Partial<PackageRunRecord> = {}): PackageRunRecord {
  return {
    runId: 'run-1',
    packageId: 'pkg',
    jobId: 'job',
    status: 'running',
    inputs: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    events: [],
    ...overrides,
  }
}

function makeAgentSession(overrides: Partial<AgentSessionRuntime> = {}): AgentSessionRuntime {
  return {
    sessionId: 'sess-1',
    agentId: 'codex',
    title: 'Codex session',
    command: 'codex',
    cwd: '/workspace',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<RunActionsDeps> = {}) {
  const packageRuns: PackageRunRecord[] = []
  const agentSessions: AgentSessionRuntime[] = []
  let activeWork: WorkEntry | null = null
  const deps: RunActionsDeps = {
    activeWork: vi.fn(() => activeWork),
    packageRuns: vi.fn(() => packageRuns),
    agentSessions: vi.fn(() => agentSessions),
    getAgentExtraArgs: vi.fn(() => []),
    callKernel: vi.fn(),
    openWorkEntry: vi.fn(async () => ({ opened: true })),
    openFallbackWork: vi.fn(async () => ({ opened: true })),
    openFilesWorkPreservingArtifact: vi.fn(async () => ({ opened: true })),
    openNextActivity: vi.fn(async () => ({ opened: true })),
    removeWorkHistoryEntry: vi.fn(async () => ({ opened: true })),
    setWorkNavigationError: vi.fn(),
    upsertPackageRun: vi.fn(run => {
      const idx = packageRuns.findIndex(item => item.runId === run.runId)
      if (idx >= 0) packageRuns[idx] = run
      else packageRuns.unshift(run)
    }),
    removePackageRun: vi.fn(runId => {
      const idx = packageRuns.findIndex(item => item.runId === runId)
      if (idx >= 0) packageRuns.splice(idx, 1)
    }),
    applyAgentSessionEvent: vi.fn(event => {
      const idx = agentSessions.findIndex(item => item.sessionId === event.session.sessionId)
      if (idx >= 0) agentSessions[idx] = event.session
      else agentSessions.unshift(event.session)
    }),
    removeAgentSession: vi.fn(sessionId => {
      const idx = agentSessions.findIndex(item => item.sessionId === sessionId)
      if (idx >= 0) agentSessions.splice(idx, 1)
    }),
    archiveChatSession: vi.fn(async () => undefined),
    deleteChatSession: vi.fn(async () => undefined),
    incrementArchiveRefresh: vi.fn(),
    refreshPackageRuns: vi.fn(),
    ...overrides,
  }
  return {
    deps,
    packageRuns,
    agentSessions,
    setActiveWork: (work: WorkEntry | null) => { activeWork = work },
  }
}

describe('app shell run actions', () => {
  it('hydrates missing app runs before opening app-run Work', async () => {
    const hydrated = makePackageRun({ label: 'Hydrated run title' })
    const { deps } = makeDeps({
      callKernel: vi.fn(async tool => {
        if (tool === 'package.jobs.get') return { run: hydrated }
        throw new Error(`unexpected ${tool}`)
      }),
    })
    const actions = createRunActions(deps)

    await actions.openPackageRunWork('pkg', 'run-1')

    expect(deps.upsertPackageRun).toHaveBeenCalledWith(hydrated)
    expect(deps.openWorkEntry).toHaveBeenCalledWith({
      id: 'work:package-run:pkg:run-1',
      kind: 'package-run',
      packageId: 'pkg',
      runId: 'run-1',
      title: 'Hydrated run title',
    })
  })

  it('archives active app runs, prunes Work history, falls back, and refreshes archive state', async () => {
    const archived = makePackageRun({ archived: true })
    const { deps, setActiveWork } = makeDeps({
      callKernel: vi.fn(async tool => {
        if (tool === 'package.jobs.archive') return { run: archived }
        throw new Error(`unexpected ${tool}`)
      }),
    })
    setActiveWork({
      id: 'work:package-run:pkg:run-1',
      kind: 'package-run',
      packageId: 'pkg',
      runId: 'run-1',
      title: 'Run',
    })
    const actions = createRunActions(deps)

    await actions.archivePackageRun('pkg', 'run-1')

    expect(deps.upsertPackageRun).toHaveBeenCalledWith(archived)
    expect(deps.removeWorkHistoryEntry).toHaveBeenCalledWith('work:package-run:pkg:run-1')
    expect(deps.openNextActivity).toHaveBeenCalledWith('work:package-run:pkg:run-1')
    expect(deps.incrementArchiveRefresh).toHaveBeenCalledOnce()
    expect(deps.refreshPackageRuns).toHaveBeenCalledOnce()
  })

  it('launches agent sessions with configured extra args and opens the returned session', async () => {
    const session = makeAgentSession({ sessionId: 'sess-2', title: 'Fresh agent' })
    const { deps } = makeDeps({
      getAgentExtraArgs: vi.fn(() => ['--dangerously-bypass-approvals']),
      callKernel: vi.fn(async tool => {
        if (tool === 'agent.launch') return { session }
        throw new Error(`unexpected ${tool}`)
      }),
    })
    const actions = createRunActions(deps)

    await actions.launchAgentSession('codex')

    expect(deps.callKernel).toHaveBeenCalledWith('agent.launch', {
      agentId: 'codex',
      extraArgs: ['--dangerously-bypass-approvals'],
    })
    expect(deps.applyAgentSessionEvent).toHaveBeenCalledWith({ type: 'session.started', session })
    expect(deps.openWorkEntry).toHaveBeenCalledWith({
      id: 'work:agent-session:sess-2',
      kind: 'agent-session',
      agentId: 'codex',
      sessionId: 'sess-2',
      title: 'Fresh agent',
    })
  })

  it('navigates to the next activity before pruning the closed entry from Work history', async () => {
    // Pruning first leaves Work history with a null current entry for one
    // render, which mounts the Files fallback surface as a visible flash.
    const archived = makeAgentSession({ archived: true, status: 'stopped' })
    const { deps, agentSessions, setActiveWork } = makeDeps({
      callKernel: vi.fn(async tool => {
        if (tool === 'agent.sessions.archive') return { session: archived }
        throw new Error(`unexpected ${tool}`)
      }),
    })
    agentSessions.push(makeAgentSession({ status: 'done' }))
    setActiveWork({
      id: 'work:agent-session:sess-1',
      kind: 'agent-session',
      agentId: 'codex',
      sessionId: 'sess-1',
      title: 'Codex session',
    })
    const actions = createRunActions(deps)

    await actions.archiveAgentSession('sess-1')

    const openOrder = vi.mocked(deps.openNextActivity).mock.invocationCallOrder[0]
    const removeOrder = vi.mocked(deps.removeWorkHistoryEntry).mock.invocationCallOrder[0]
    expect(openOrder).toBeLessThan(removeOrder)
  })

  it('archives active agent sessions using the stored agent id for Work history cleanup', async () => {
    const archived = makeAgentSession({ archived: true })
    const { deps, agentSessions, setActiveWork } = makeDeps({
      callKernel: vi.fn(async tool => {
        if (tool === 'agent.sessions.archive') return { session: archived }
        throw new Error(`unexpected ${tool}`)
      }),
    })
    agentSessions.push(makeAgentSession({ status: 'done' }))
    setActiveWork({
      id: 'work:agent-session:sess-1',
      kind: 'agent-session',
      agentId: 'codex',
      sessionId: 'sess-1',
      title: 'Codex session',
    })
    const actions = createRunActions(deps)

    await actions.archiveAgentSession('sess-1')

    expect(deps.applyAgentSessionEvent).toHaveBeenCalledWith({ type: 'session.changed', session: archived })
    expect(deps.removeWorkHistoryEntry).toHaveBeenCalledWith('work:agent-session:sess-1')
    expect(deps.openNextActivity).toHaveBeenCalledWith('work:agent-session:sess-1')
    expect(deps.incrementArchiveRefresh).toHaveBeenCalledOnce()
  })

  it('stops running agent sessions before archiving them', async () => {
    const archived = makeAgentSession({ archived: true, status: 'stopped' })
    const { deps, agentSessions } = makeDeps({
      callKernel: vi.fn(async tool => {
        if (tool === 'agent.stop') return { session: makeAgentSession({ status: 'stopped' }) }
        if (tool === 'agent.sessions.archive') return { session: archived }
        throw new Error(`unexpected ${tool}`)
      }),
    })
    agentSessions.push(makeAgentSession({ status: 'running' }))
    const actions = createRunActions(deps)

    await actions.archiveAgentSession('sess-1')

    expect(deps.callKernel).toHaveBeenNthCalledWith(1, 'agent.stop', { sessionId: 'sess-1' })
    expect(deps.callKernel).toHaveBeenNthCalledWith(2, 'agent.sessions.archive', { sessionId: 'sess-1' })
    expect(deps.applyAgentSessionEvent).toHaveBeenCalledWith({ type: 'session.changed', session: archived })
  })

  it('deletes active agent sessions, prunes Work history, navigates to next activity, and refreshes archive state', async () => {
    const { deps, agentSessions, setActiveWork } = makeDeps({
      callKernel: vi.fn(async tool => {
        if (tool === 'agent.sessions.delete') return { deleted: 'sess-1' }
        throw new Error(`unexpected ${tool}`)
      }),
    })
    agentSessions.push(makeAgentSession())
    setActiveWork({
      id: 'work:agent-session:sess-1',
      kind: 'agent-session',
      agentId: 'codex',
      sessionId: 'sess-1',
      title: 'Codex session',
    })
    const actions = createRunActions(deps)

    await actions.deleteAgentSession('sess-1')

    expect(deps.callKernel).toHaveBeenCalledWith('agent.sessions.delete', { sessionId: 'sess-1' })
    expect(deps.removeAgentSession).toHaveBeenCalledWith('sess-1')
    expect(deps.removeWorkHistoryEntry).toHaveBeenCalledWith('work:agent-session:sess-1')
    expect(deps.openNextActivity).toHaveBeenCalledWith('work:agent-session:sess-1')
    expect(deps.incrementArchiveRefresh).toHaveBeenCalledOnce()
  })

  it('archives and deletes active chat sessions then navigates to next activity', async () => {
    const { deps, setActiveWork } = makeDeps()
    setActiveWork({
      id: 'work:chat:s1',
      kind: 'chat',
      sessionId: 's1',
      title: 'Chat',
    })
    const actions = createRunActions(deps)

    await actions.archiveSession('s1')
    await actions.deleteSession('s1')

    expect(deps.archiveChatSession).toHaveBeenCalledWith('s1')
    expect(deps.deleteChatSession).toHaveBeenCalledWith('s1')
    expect(deps.removeWorkHistoryEntry).toHaveBeenNthCalledWith(1, 'work:chat:s1')
    expect(deps.removeWorkHistoryEntry).toHaveBeenNthCalledWith(2, 'work:chat:s1')
    expect(deps.openNextActivity).toHaveBeenNthCalledWith(1, 'work:chat:s1')
    expect(deps.openNextActivity).toHaveBeenNthCalledWith(2, 'work:chat:s1')
    expect(deps.incrementArchiveRefresh).toHaveBeenCalledTimes(2)
  })

  it('routes lifecycle errors to Work navigation recovery', async () => {
    const err = new Error('boom')
    const { deps } = makeDeps({
      callKernel: vi.fn(async () => { throw err }),
    })
    const actions = createRunActions(deps)

    await actions.stopAgentSession('sess-1')

    expect(deps.setWorkNavigationError).toHaveBeenCalledWith(err)
  })
})
