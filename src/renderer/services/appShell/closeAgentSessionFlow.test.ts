// Integration flow: Cmd+W on the last agent session must land on a draft
// chat. Wires the real workbench/runs/sessions stores, closeTabActions, and
// runActions the way App.vue does, so the whole close chain is under test —
// including the focus-routing guard that once swallowed the close when DOM
// focus lingered in an empty Artifact pane.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { useRunsStore, type AgentSessionRuntime } from '../../stores/runs.js'
import { useSessionStore } from '../../stores/sessions.js'
import { createRunActions } from './runActions.js'
import { createWorkbenchActions } from './workbenchActions.js'
import { createWorkSurfaceActions } from './workSurfaceActions.js'
import { handleCloseTab as executeCloseTabAction } from './closeTabActions.js'
import { agentSessionWorkEntry, type WorkEntry } from '../workbench/entries.js'
import { resolveWorkHost } from '../workbench/hosts.js'

function agentSession(overrides: Partial<AgentSessionRuntime> = {}): AgentSessionRuntime {
  return {
    sessionId: 'sess-1',
    agentId: 'claude-code',
    title: 'Claude Code',
    command: 'claude',
    cwd: '/ws',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface Harness {
  archivePromise: Promise<void> | null
  pressCloseTab: (options?: { editorPaneFocused?: boolean; hasArtifactTab?: boolean }) => void
  activeWorkKind: () => string | undefined
  kernelCalls: ReturnType<typeof vi.fn>
}

function makeHarness(seed: AgentSessionRuntime): Harness {
  const workbenchStore = useWorkbenchStore()
  const runsStore = useRunsStore()
  const sessionStore = useSessionStore()

  const callKernel = vi.fn(async (tool: string) => {
    if (tool === 'agent.stop') return { session: { ...seed, status: 'stopped' } }
    if (tool === 'agent.sessions.archive') {
      return { session: { ...seed, status: 'stopped', archived: true } }
    }
    throw new Error(`unexpected kernel call: ${tool}`)
  })

  const workbenchActions = createWorkbenchActions({
    activeWork: () => workbenchStore.activeWork,
    activeArtifact: () => workbenchStore.activeArtifact,
    activeSessionId: () => sessionStore.activeSessionId,
    setActiveSessionId: sessionId => { sessionStore.activeSessionId = sessionId },
    selectSession: sessionId => sessionStore.select(sessionId),
    createArtifactNavigationSnapshot: () => workbenchStore.createArtifactNavigationSnapshot(),
    restoreArtifactNavigationSnapshot: snapshot => workbenchStore.restoreArtifactNavigationSnapshot(
      snapshot as ReturnType<typeof workbenchStore.createArtifactNavigationSnapshot>,
    ),
    openWorkInStore: (entry, options) => workbenchStore.openWork(entry, options),
    openArtifactInStore: (entry, options) => workbenchStore.openArtifact(entry, options),
    backInStore: (pane, options) => workbenchStore.back(pane, options),
    forwardInStore: (pane, options) => workbenchStore.forward(pane, options),
    removePaneHistoryEntry: (pane, entryId, options) => workbenchStore.removePaneHistoryEntry(pane, entryId, options),
    setPaneState: (pane, state) => workbenchStore.setPaneState(pane, state),
    setPaneVisibility: (pane, visible) => workbenchStore.setPaneVisibility(pane, visible),
    setNavigationError: (pane, error) => workbenchStore.setNavigationError(pane, error),
    confirmArtifactReplacement: () => true,
    nextTick: async () => {},
    openFileInArtifactHost: () => {},
  })

  const openWorkEntry = (entry: WorkEntry, options?: Parameters<typeof workbenchActions.openWorkEntry>[1]) =>
    workbenchActions.openWorkEntry(entry, options)

  const workSurfaceActions = createWorkSurfaceActions({
    activeSessionId: () => sessionStore.activeSessionId,
    sessionLabel: sessionId => sessionStore.sessions.find(session => session.id === sessionId)?.label,
    packages: () => [],
    openWorkEntry,
    incrementFilesRefresh: () => {},
    incrementArchiveRefresh: () => {},
    visibleSessions: () => sessionStore.visibleSessions,
  })

  // App.vue's openNextActivity glue, reduced to the states this flow reaches.
  async function openNextActivity(closingEntryId: string) {
    const remaining = runsStore.agentSessionRuns
      .filter(run => `work:agent-session:${run.sourceId}` !== closingEntryId)
    if (remaining.length) {
      const next = remaining[0]
      const agentId = runsStore.agentSessions.find(item => item.sessionId === next.sourceId)?.agentId ?? ''
      await runActions.openAgentSessionWork(agentId, next.sourceId)
    } else {
      await workSurfaceActions.openDraftChatWork()
    }
  }

  const runActions = createRunActions({
    activeWork: () => workbenchStore.activeWork,
    packageRuns: () => runsStore.packageRuns,
    agentSessions: () => runsStore.agentSessions,
    getAgentExtraArgs: () => [],
    callKernel,
    openWorkEntry,
    openFallbackWork: () => workSurfaceActions.openFallbackWork(),
    openFilesWorkPreservingArtifact: () => workSurfaceActions.openFilesWorkPreservingArtifact(),
    openNextActivity,
    removeWorkHistoryEntry: entryId => workbenchStore.removePaneHistoryEntry('work', entryId),
    setWorkNavigationError: err => workbenchStore.setNavigationError('work', err),
    upsertPackageRun: run => runsStore.upsertPackageRun(run),
    removePackageRun: runId => runsStore.removePackageRun(runId),
    applyAgentSessionEvent: event => runsStore.applyAgentSessionEvent(event),
    removeAgentSession: sessionId => runsStore.removeAgentSession(sessionId),
    archiveChatSession: sessionId => sessionStore.archive(sessionId),
    deleteChatSession: sessionId => sessionStore.remove(sessionId),
    incrementArchiveRefresh: () => {},
    refreshPackageRuns: async () => {},
  })

  const harness: Harness = {
    archivePromise: null,
    kernelCalls: callKernel,
    activeWorkKind: () => workbenchStore.activeWork?.kind,
    pressCloseTab: (options = {}) => {
      executeCloseTabAction({
        editorPaneFocused: () => options.editorPaneFocused ?? false,
        activeWorkHost: () => resolveWorkHost(workbenchStore.activeWork),
        closeActiveArtifactTab: () => {},
        closeTerminalTab: () => {},
        artifactVisible: () => true,
        hasActiveArtifactTab: () => options.hasArtifactTab ?? false,
        activeArtifactHostId: () => 'editor',
        activeSession: () => sessionStore.activeSession,
        archiveSession: () => {},
        activeAgentSessionId: () => workbenchStore.activeWork?.kind === 'agent-session'
          ? workbenchStore.activeWork.sessionId
          : null,
        archiveAgentSession: sessionId => { harness.archivePromise = runActions.archiveAgentSession(sessionId) },
        activePackageRun: () => null,
        archivePackageRun: () => {},
      })
    },
  }
  return harness
}

describe('closing the last agent session via Cmd+W', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('stops, archives, and lands on a draft chat when no other activity remains', async () => {
    const runsStore = useRunsStore()
    const seed = agentSession()
    runsStore.setAgentSessions([seed])
    const harness = makeHarness(seed)
    const workbenchStore = useWorkbenchStore()
    await workbenchStore.openWork(agentSessionWorkEntry('claude-code', 'sess-1', 'Claude Code'))

    harness.pressCloseTab()
    expect(harness.archivePromise).not.toBeNull()
    await harness.archivePromise

    expect(harness.kernelCalls).toHaveBeenCalledWith('agent.stop', { sessionId: 'sess-1' })
    expect(harness.kernelCalls).toHaveBeenCalledWith('agent.sessions.archive', { sessionId: 'sess-1' })
    expect(harness.activeWorkKind()).toBe('chat-draft')
  })

  it('archives an errored session even when stale focus sits in an empty Artifact pane', async () => {
    // The reported field failure: a crashed CLI session (status 'error'),
    // DOM focus left behind in the editor pane with no tab open. Cmd+W used
    // to route to the empty editor and silently do nothing.
    const runsStore = useRunsStore()
    const seed = agentSession({ status: 'error', exitCode: 1, endedAt: '2026-01-01T00:01:00.000Z' })
    runsStore.setAgentSessions([seed])
    const harness = makeHarness(seed)
    const workbenchStore = useWorkbenchStore()
    await workbenchStore.openWork(agentSessionWorkEntry('claude-code', 'sess-1', 'Claude Code'))

    harness.pressCloseTab({ editorPaneFocused: true, hasArtifactTab: false })
    expect(harness.archivePromise).not.toBeNull()
    await harness.archivePromise

    expect(harness.kernelCalls).not.toHaveBeenCalledWith('agent.stop', { sessionId: 'sess-1' })
    expect(harness.kernelCalls).toHaveBeenCalledWith('agent.sessions.archive', { sessionId: 'sess-1' })
    expect(harness.activeWorkKind()).toBe('chat-draft')
  })
})
