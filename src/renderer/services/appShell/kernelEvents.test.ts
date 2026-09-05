import { describe, expect, it, vi } from 'vitest'
import {
  registerAppKernelEvents,
  type AppKernelEventDeps,
  type KernelEventBus,
} from './kernelEvents.js'

function makeHarness(overrides: Partial<AppKernelEventDeps> = {}) {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const kernel: KernelEventBus = {
    on: vi.fn((channel, cb) => {
      handlers.set(channel, cb)
    }),
    off: vi.fn((channel, cb) => {
      if (handlers.get(channel) === cb) handlers.delete(channel)
    }),
  }
  const deps: AppKernelEventDeps = {
    setPackages: vi.fn(),
    refreshApps: vi.fn(),
    refreshAppAgents: vi.fn(),
    handleWorkspaceChanged: vi.fn(),
    refreshKeyStatuses: vi.fn(),
    enqueueApproval: vi.fn(),
    openFileInEditor: vi.fn(),
    routeBridgeChatSend: vi.fn(),
    routeBridgeWorkbenchOpenWork: vi.fn(),
    routeBridgeWorkbenchOpenArtifact: vi.fn(),
    openFileViaDialog: vi.fn(),
    createUntitledInEditor: vi.fn(),
    handleSaveFile: vi.fn(),
    openExportDialog: vi.fn(),
    clearRecentFiles: vi.fn(),
    handleCloseTab: vi.fn(),
    openSettings: vi.fn(),
    openShortcuts: vi.fn(),
    openWelcome: vi.fn(),
    dispatchTerminalRun: vi.fn(),
    onPackageJobEvent: vi.fn(),
    onAgentSessionEvent: vi.fn(),
    refreshSubagentSession: vi.fn(),
    pushToast: vi.fn(),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  return {
    deps,
    kernel,
    emit: (channel: string, payload?: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for ${channel}`)
      handler(payload)
    },
    registeredChannels: () => [...handlers.keys()],
  }
}

describe('app shell kernel events', () => {
  it('registers every App-level kernel event and unregisters the exact handlers', () => {
    const { deps, kernel, registeredChannels } = makeHarness()

    const unregister = registerAppKernelEvents(kernel, deps)

    expect(registeredChannels()).toEqual([
      'packages:changed',
      'workspace:changed',
      'apps:changed',
      'ai:keys-changed',
      'gate:request',
      'bridge:editor:open',
      'bridge:chat:send',
      'bridge:workbench:open-work',
      'bridge:workbench:open-artifact',
      'menu:open-file',
      'menu:new-document',
      'menu:save-file',
      'menu:save-file-as',
      'menu:export-document',
      'menu:open-recent',
      'menu:clear-recent',
      'menu:close-tab',
      'menu:settings',
      'menu:shortcuts',
      'menu:welcome',
      'bridge:terminal:run',
      'package:job:event',
      'agent:session-event',
      'subagent:event',
      'team:update-available',
      'app:update-available',
      'app:update-progress',
      'app:update-downloaded',
      'app:update-error',
      'editor:adopt-tab',
      'popout:main-command',
    ])

    unregister()

    expect(kernel.off).toHaveBeenCalledTimes(31)
    expect(registeredChannels()).toEqual([])
    expect(deps.refreshApps).not.toHaveBeenCalled()
  })

  it('updates package and local app state from kernel events', () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)

    const packages = [{ manifest: { id: 'slides', name: 'Slides' }, dir: '/pkg', source: 'mim' }]
    emit('packages:changed', packages)
    emit('apps:changed')

    expect(deps.setPackages).toHaveBeenCalledWith(packages)
    expect(deps.refreshApps).toHaveBeenCalledTimes(2)
  })

  it('routes bridge and menu events through the same App shell actions', () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)

    emit('bridge:editor:open', { path: 'docs/a.md' })
    emit('bridge:editor:open', { path: 123 })
    emit('bridge:chat:send', { message: 'hello' })
    emit('bridge:workbench:open-work', { kind: 'package-run' })
    emit('bridge:workbench:open-artifact', { kind: 'ignored' })
    emit('bridge:terminal:run', { command: 'npm test' })
    emit('bridge:terminal:run', { command: 'npm run lint', reveal: false })
    emit('bridge:terminal:run', { command: 42 })
    emit('menu:open-recent', 'docs/recent.md')
    emit('menu:open-recent', 12)
    emit('menu:save-file')
    emit('menu:save-file-as')

    expect(deps.openFileInEditor).toHaveBeenCalledTimes(2)
    expect(deps.openFileInEditor).toHaveBeenNthCalledWith(1, 'docs/a.md')
    expect(deps.openFileInEditor).toHaveBeenNthCalledWith(2, 'docs/recent.md')
    expect(deps.routeBridgeChatSend).toHaveBeenCalledWith({ message: 'hello' })
    expect(deps.routeBridgeWorkbenchOpenWork).toHaveBeenCalledWith({ kind: 'package-run' })
    expect(deps.routeBridgeWorkbenchOpenArtifact).toHaveBeenCalledWith({ kind: 'ignored' })
    expect(deps.dispatchTerminalRun).toHaveBeenNthCalledWith(1, 'npm test', undefined)
    expect(deps.dispatchTerminalRun).toHaveBeenNthCalledWith(2, 'npm run lint', { reveal: false })
    expect(deps.handleSaveFile).toHaveBeenNthCalledWith(1, false)
    expect(deps.handleSaveFile).toHaveBeenNthCalledWith(2, true)
  })

  it('routes direct menu, approval, key, app, and agent events', () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)
    const approval = { requestId: 'req-1' }
    const packageEvent = { runId: 'run-1' }
    const agentEvent = { session: { sessionId: 's1' } }
    const subagentEvent = { sessionId: 'child-1', status: 'done' }

    emit('workspace:changed', '/workspace')
    emit('ai:keys-changed')
    emit('gate:request', approval)
    emit('menu:open-file')
    emit('menu:new-document')
    emit('menu:export-document')
    emit('menu:clear-recent')
    emit('menu:close-tab')
    emit('menu:settings')
    emit('menu:shortcuts')
    emit('menu:welcome')
    emit('package:job:event', packageEvent)
    emit('agent:session-event', agentEvent)
    emit('subagent:event', subagentEvent)

    expect(deps.handleWorkspaceChanged).toHaveBeenCalledWith('/workspace')
    expect(deps.refreshKeyStatuses).toHaveBeenCalledOnce()
    expect(deps.enqueueApproval).toHaveBeenCalledWith(approval)
    expect(deps.openFileViaDialog).toHaveBeenCalledOnce()
    expect(deps.createUntitledInEditor).toHaveBeenCalledOnce()
    expect(deps.openExportDialog).toHaveBeenCalledOnce()
    expect(deps.clearRecentFiles).toHaveBeenCalledOnce()
    expect(deps.handleCloseTab).toHaveBeenCalledOnce()
    expect(deps.openSettings).toHaveBeenNthCalledWith(1)
    expect(deps.openShortcuts).toHaveBeenCalledOnce()
    expect(deps.openWelcome).toHaveBeenCalledOnce()
    expect(deps.onPackageJobEvent).toHaveBeenCalledWith(packageEvent)
    expect(deps.onAgentSessionEvent).toHaveBeenCalledWith(agentEvent)
    expect(deps.refreshSubagentSession).toHaveBeenCalledWith('child-1')
  })

  it('shows a persistent download toast when an app update is available', async () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)

    emit('app:update-available', { version: '1.2.3', releaseNotes: 'Fixes' })

    expect(deps.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'info',
      message: 'Mim 1.2.3 is available',
      detail: 'Fixes',
      actionLabel: 'Download',
      durationMs: null,
    }))
    const toast = vi.mocked(deps.pushToast).mock.calls[0][0]
    await toast.action?.()
    expect(deps.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('offers one plain-language route to review an available Team update', async () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)

    emit('team:update-available', {
      teamName: 'Acme Research',
      changes: [
        { kind: 'app', name: 'Knowledge', action: 'updated' },
        { kind: 'skill', name: 'Build App', action: 'updated' },
      ],
    })

    expect(deps.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'info',
      message: 'Acme Research has an update',
      detail: 'Knowledge and Build App',
      actionLabel: 'Review',
      durationMs: null,
    }))
    const toast = vi.mocked(deps.pushToast).mock.calls[0][0]
    await toast.action?.()
    expect(deps.openSettings).toHaveBeenCalledWith('team')
  })

  it('shows an error toast if a user-triggered update download fails', async () => {
    const downloadUpdate = vi.fn().mockRejectedValue(new Error('network down'))
    const { deps, kernel, emit } = makeHarness({ downloadUpdate })
    registerAppKernelEvents(kernel, deps)

    emit('app:update-available', { version: '1.2.3' })
    const toast = vi.mocked(deps.pushToast).mock.calls[0][0]
    await toast.action?.()

    expect(deps.pushToast).toHaveBeenLastCalledWith({
      kind: 'error',
      message: 'Update download failed',
      detail: 'network down',
    })
  })

  it('shows a persistent restart toast when an app update has downloaded', async () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)

    emit('app:update-downloaded', { version: '1.2.3' })

    expect(deps.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'info',
      message: 'Mim 1.2.3 is ready to install',
      actionLabel: 'Restart',
      durationMs: null,
    }))
    const toast = vi.mocked(deps.pushToast).mock.calls[0][0]
    await toast.action?.()
    expect(deps.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('keeps background updater error events quiet', () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)

    emit('app:update-error', { message: 'metadata missing' })

    expect(deps.pushToast).not.toHaveBeenCalled()
  })

  it('routes editor:adopt-tab to the adoptTab dep', () => {
    const adoptTab = vi.fn()
    const { deps, kernel, emit } = makeHarness({ adoptTab })
    registerAppKernelEvents(kernel, deps)

    emit('editor:adopt-tab', { path: 'notes.md', kind: 'text', name: 'notes.md', dirty: false })

    expect(adoptTab).toHaveBeenCalledWith({ path: 'notes.md', kind: 'text', name: 'notes.md', dirty: false })
  })

  it('tolerates missing adoptTab dep gracefully', () => {
    const { deps, kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, deps)

    // adoptTab is not provided in default harness — should not throw
    expect(() => {
      emit('editor:adopt-tab', { path: 'test.md', kind: 'text', name: 'test.md', dirty: false })
    }).not.toThrow()
  })

  // ── popout:main-command ──

  it('routes terminal.send from popout:main-command to dispatchTerminalSend', () => {
    const dispatchTerminalSend = vi.fn()
    const { kernel, emit } = makeHarness({ dispatchTerminalSend })
    registerAppKernelEvents(kernel, { ...makeHarness().deps, dispatchTerminalSend })

    emit('popout:main-command', {
      type: 'terminal.send',
      payload: { text: 'print("hello")', language: 'python' },
    })

    expect(dispatchTerminalSend).toHaveBeenCalledWith('print("hello")', 'python')
  })

  it('routes terminal.send with null language when language is absent', () => {
    const dispatchTerminalSend = vi.fn()
    const harness = makeHarness({ dispatchTerminalSend })
    registerAppKernelEvents(harness.kernel, harness.deps)

    harness.emit('popout:main-command', {
      type: 'terminal.send',
      payload: { text: 'echo hi' },
    })

    expect(dispatchTerminalSend).toHaveBeenCalledWith('echo hi', null)
  })

  it('routes chat.prepareDraft from popout:main-command to prepareChatDraft', () => {
    const prepareChatDraft = vi.fn()
    const harness = makeHarness({ prepareChatDraft })
    registerAppKernelEvents(harness.kernel, harness.deps)

    harness.emit('popout:main-command', {
      type: 'chat.prepareDraft',
      payload: {
        text: 'Review this',
        attachments: [{ type: 'file', path: 'a.md' }],
        contextChips: [{ kind: 'file', path: 'b.md' }],
        targetSessionId: 'sess-1',
      },
    })

    expect(prepareChatDraft).toHaveBeenCalledWith({
      targetSessionId: 'sess-1',
      text: 'Review this',
      attachments: [{ type: 'file', path: 'a.md' }],
      contextChips: [{ kind: 'file', path: 'b.md' }],
    })
  })

  it('tolerates missing dispatchTerminalSend and prepareChatDraft deps', () => {
    const { kernel, emit } = makeHarness()
    registerAppKernelEvents(kernel, makeHarness().deps)

    // Neither dep is provided — should not throw
    expect(() => {
      emit('popout:main-command', { type: 'terminal.send', payload: { text: 'x' } })
    }).not.toThrow()
    expect(() => {
      emit('popout:main-command', { type: 'chat.prepareDraft', payload: { text: 'y', attachments: [] } })
    }).not.toThrow()
  })

  it('ignores malformed popout:main-command payloads', () => {
    const dispatchTerminalSend = vi.fn()
    const prepareChatDraft = vi.fn()
    const harness = makeHarness({ dispatchTerminalSend, prepareChatDraft })
    registerAppKernelEvents(harness.kernel, harness.deps)

    // No type field
    harness.emit('popout:main-command', { payload: { text: 'x' } })
    // Non-string type
    harness.emit('popout:main-command', { type: 42, payload: { text: 'x' } })
    // Unknown type
    harness.emit('popout:main-command', { type: 'unknown.verb', payload: { text: 'x' } })
    // Missing payload
    harness.emit('popout:main-command', { type: 'terminal.send' })
    // Non-string text in terminal.send
    harness.emit('popout:main-command', { type: 'terminal.send', payload: { text: 123 } })
    // Non-object payload
    harness.emit('popout:main-command', { type: 'terminal.send', payload: 'bad' })
    // Null data
    harness.emit('popout:main-command', null)

    expect(dispatchTerminalSend).not.toHaveBeenCalled()
    expect(prepareChatDraft).not.toHaveBeenCalled()
  })
})
