export interface CloseTabSession {
  id: string
  archived?: boolean
}

export interface CloseTabActionsDeps {
  /**
   * Focus anywhere in the Artifact pane — not just CodeMirror. PDF, table,
   * image, and file-card tabs must close via Cmd+W the same as text tabs.
   */
  editorPaneFocused(): boolean
  activeWorkHost(): string
  closeActiveArtifactTab(): void
  closeTerminalTab(): void
  artifactVisible(): boolean
  /** Any document tab (text, PDF, table, file card) active in the editor. */
  hasActiveArtifactTab(): boolean
  activeArtifactHostId(): string
  activeSession(): CloseTabSession | null
  archiveSession(sessionId: string): void
  activeAgentSessionId(): string | null
  archiveAgentSession(sessionId: string): void
  activePackageRun(): { packageId: string; runId: string } | null
  archivePackageRun(packageId: string, runId: string): void
}

export function handleCloseTab(deps: CloseTabActionsDeps): void {
  // Editor focus only claims Cmd+W while there is a visible tab to close.
  // DOM focus can linger in an empty or railed Artifact pane (e.g. after the
  // last document tab closed); routing Cmd+W there would silently do nothing
  // while the user is looking at a Work surface they expect to close.
  if (deps.editorPaneFocused() && deps.artifactVisible() && deps.hasActiveArtifactTab()) {
    deps.closeActiveArtifactTab()
    return
  }
  if (deps.activeWorkHost() === 'terminal') {
    deps.closeTerminalTab()
    return
  }

  const host = deps.activeWorkHost()

  if (host === 'chat') {
    const session = deps.activeSession()
    if (session && !session.archived) deps.archiveSession(session.id)
    return
  }
  if (host === 'agent-session') {
    const sessionId = deps.activeAgentSessionId()
    if (sessionId) deps.archiveAgentSession(sessionId)
    return
  }
  if (host === 'package-run') {
    const run = deps.activePackageRun()
    if (run) deps.archivePackageRun(run.packageId, run.runId)
    return
  }

  if (deps.artifactVisible() && deps.activeArtifactHostId() === 'editor') {
    deps.closeActiveArtifactTab()
    return
  }

  const session = deps.activeSession()
  if (session && !session.archived) deps.archiveSession(session.id)
}
