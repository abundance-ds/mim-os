import { describe, expect, it, vi } from 'vitest'
import {
  handleCloseTab,
  type CloseTabActionsDeps,
} from './closeTabActions.js'

function makeDeps(overrides: Partial<CloseTabActionsDeps> = {}) {
  const deps: CloseTabActionsDeps = {
    editorPaneFocused: vi.fn(() => false),
    activeWorkHost: vi.fn(() => 'chat'),
    closeActiveArtifactTab: vi.fn(),
    closeTerminalTab: vi.fn(),
    artifactVisible: vi.fn(() => false),
    hasActiveArtifactTab: vi.fn(() => true),
    activeArtifactHostId: vi.fn(() => ''),
    activeSession: vi.fn(() => ({ id: 's1', archived: false })),
    archiveSession: vi.fn(),
    activeAgentSessionId: vi.fn(() => null),
    archiveAgentSession: vi.fn(),
    activePackageRun: vi.fn(() => null),
    archivePackageRun: vi.fn(),
    ...overrides,
  }
  return deps
}

describe('app shell close-tab actions', () => {
  it('closes the focused editor tab first', () => {
    const deps = makeDeps({
      editorPaneFocused: vi.fn(() => true),
      artifactVisible: vi.fn(() => true),
      activeWorkHost: vi.fn(() => 'terminal'),
    })

    handleCloseTab(deps)

    expect(deps.closeActiveArtifactTab).toHaveBeenCalledOnce()
    expect(deps.closeTerminalTab).not.toHaveBeenCalled()
    expect(deps.archiveSession).not.toHaveBeenCalled()
  })

  it('closes non-text document tabs (PDF, table, image) instead of archiving the chat', () => {
    // Focus on a PDF/table/image tab lives in the Artifact pane but never in
    // CodeMirror; Cmd+W must still close the document tab, not the session.
    const deps = makeDeps({
      editorPaneFocused: vi.fn(() => true),
      artifactVisible: vi.fn(() => true),
      activeWorkHost: vi.fn(() => 'chat'),
    })

    handleCloseTab(deps)

    expect(deps.closeActiveArtifactTab).toHaveBeenCalledOnce()
    expect(deps.archiveSession).not.toHaveBeenCalled()
  })

  it('routes to the Work surface when editor focus has no tab to close', () => {
    // Stale focus in an empty Artifact pane must not swallow Cmd+W: the
    // visible Work surface (here an agent session) is what the user closes.
    const deps = makeDeps({
      editorPaneFocused: vi.fn(() => true),
      artifactVisible: vi.fn(() => true),
      hasActiveArtifactTab: vi.fn(() => false),
      activeWorkHost: vi.fn(() => 'agent-session'),
      activeAgentSessionId: vi.fn(() => 'agent-1'),
    })

    handleCloseTab(deps)

    expect(deps.closeActiveArtifactTab).not.toHaveBeenCalled()
    expect(deps.archiveAgentSession).toHaveBeenCalledWith('agent-1')
  })

  it('routes to the Work surface when editor focus lingers in a hidden Artifact pane', () => {
    // A railed Artifact pane can keep DOM focus; Cmd+W still targets what is
    // on screen, not the invisible editor tab.
    const deps = makeDeps({
      editorPaneFocused: vi.fn(() => true),
      artifactVisible: vi.fn(() => false),
      activeWorkHost: vi.fn(() => 'agent-session'),
      activeAgentSessionId: vi.fn(() => 'agent-1'),
    })

    handleCloseTab(deps)

    expect(deps.closeActiveArtifactTab).not.toHaveBeenCalled()
    expect(deps.archiveAgentSession).toHaveBeenCalledWith('agent-1')
  })

  it('closes the active terminal tab when Terminal Work is active', () => {
    const deps = makeDeps({
      activeWorkHost: vi.fn(() => 'terminal'),
    })

    handleCloseTab(deps)

    expect(deps.closeTerminalTab).toHaveBeenCalledOnce()
    expect(deps.closeActiveArtifactTab).not.toHaveBeenCalled()
    expect(deps.archiveSession).not.toHaveBeenCalled()
  })

  it('archives the active chat session when chat Work is active', () => {
    const deps = makeDeps({
      activeWorkHost: vi.fn(() => 'chat'),
      artifactVisible: vi.fn(() => true),
      activeArtifactHostId: vi.fn(() => 'editor'),
    })

    handleCloseTab(deps)

    expect(deps.archiveSession).toHaveBeenCalledWith('s1')
    expect(deps.closeActiveArtifactTab).not.toHaveBeenCalled()
  })

  it('archives agent session when agent-session Work is active', () => {
    const deps = makeDeps({
      activeWorkHost: vi.fn(() => 'agent-session'),
      activeAgentSessionId: vi.fn(() => 'agent-1'),
      artifactVisible: vi.fn(() => true),
      activeArtifactHostId: vi.fn(() => 'editor'),
    })

    handleCloseTab(deps)

    expect(deps.archiveAgentSession).toHaveBeenCalledWith('agent-1')
    expect(deps.closeActiveArtifactTab).not.toHaveBeenCalled()
    expect(deps.archiveSession).not.toHaveBeenCalled()
  })

  it('archives package run when package-run Work is active', () => {
    const deps = makeDeps({
      activeWorkHost: vi.fn(() => 'package-run'),
      activePackageRun: vi.fn(() => ({ packageId: 'pkg-1', runId: 'run-1' })),
    })

    handleCloseTab(deps)

    expect(deps.archivePackageRun).toHaveBeenCalledWith('pkg-1', 'run-1')
    expect(deps.archiveSession).not.toHaveBeenCalled()
  })

  it('closes visible editor Artifact tab when Work host has no closeable content', () => {
    const deps = makeDeps({
      activeWorkHost: vi.fn(() => 'files'),
      artifactVisible: vi.fn(() => true),
      activeArtifactHostId: vi.fn(() => 'editor'),
    })

    handleCloseTab(deps)

    expect(deps.closeActiveArtifactTab).toHaveBeenCalledOnce()
    expect(deps.archiveSession).not.toHaveBeenCalled()
  })

  it('falls back to archiving active session when nothing else matches', () => {
    const deps = makeDeps({
      activeWorkHost: vi.fn(() => 'files'),
    })

    handleCloseTab(deps)

    expect(deps.archiveSession).toHaveBeenCalledWith('s1')
  })

  it('does nothing without an active unarchived session', () => {
    const archived = makeDeps({
      activeWorkHost: vi.fn(() => 'files'),
      activeSession: vi.fn(() => ({ id: 's1', archived: true })),
    })
    const missing = makeDeps({
      activeWorkHost: vi.fn(() => 'files'),
      activeSession: vi.fn(() => null),
    })

    handleCloseTab(archived)
    handleCloseTab(missing)

    expect(archived.archiveSession).not.toHaveBeenCalled()
    expect(missing.archiveSession).not.toHaveBeenCalled()
  })
})
