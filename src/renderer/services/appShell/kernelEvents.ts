import type { LoadedPackage } from './types.js'
import type { SettingsSection } from '../../components/settings/sections.js'

export interface KernelEventBus {
  on(channel: string, cb: (...args: unknown[]) => void): void
  off(channel: string, cb: (...args: unknown[]) => void): void
}

export interface AppShellToast {
  kind: 'error' | 'info'
  message: string
  detail?: string
  actionLabel?: string
  action?: () => void | Promise<void>
  durationMs?: number | null
}

export interface AppKernelEventDeps {
  setPackages(packages: LoadedPackage[]): void
  refreshApps(): Promise<unknown> | unknown
  refreshAppAgents(): Promise<unknown> | unknown
  handleWorkspaceChanged(path: unknown): Promise<unknown> | unknown
  refreshKeyStatuses(): Promise<unknown> | unknown
  enqueueApproval(request: unknown): void
  openFileInEditor(path: string): Promise<unknown> | unknown
  routeBridgeChatSend(data: unknown): Promise<unknown> | unknown
  routeBridgeWorkbenchOpenWork(data: unknown): Promise<unknown> | unknown
  routeBridgeWorkbenchOpenArtifact(data: unknown): Promise<unknown> | unknown
  openFileViaDialog(): Promise<unknown> | unknown
  createUntitledInEditor(): Promise<unknown> | unknown
  handleSaveFile(forceDialog: boolean): void
  openExportDialog(): void
  clearRecentFiles(): void
  handleCloseTab(): void
  openSettings(section?: SettingsSection): void
  openShortcuts(): void
  openWelcome(): void
  dispatchTerminalRun(command: string, options?: { reveal?: boolean }): Promise<unknown> | unknown
  onPackageJobEvent(payload: unknown): void
  onAgentSessionEvent(payload: unknown): void
  refreshSubagentSession(sessionId: string): Promise<unknown> | unknown
  pushToast(toast: AppShellToast): void
  downloadUpdate(): Promise<unknown> | unknown
  quitAndInstall(): Promise<unknown> | unknown
  adoptTab?(tab: unknown): void
  dispatchTerminalSend?(text: string, language: string | null): void
  prepareChatDraft?(payload: { targetSessionId?: string | null; text: string; attachments: unknown[]; contextChips?: unknown[] }): Promise<unknown> | unknown
}

export function registerAppKernelEvents(
  kernel: KernelEventBus,
  deps: AppKernelEventDeps,
): () => void {
  const registrations: Array<[string, (...args: unknown[]) => void]> = [
    ['packages:changed', (pkgs: unknown) => {
      deps.setPackages(pkgs as LoadedPackage[])
      void deps.refreshApps()
      void deps.refreshAppAgents()
    }],
    ['workspace:changed', (path: unknown) => {
      void deps.handleWorkspaceChanged(path)
    }],
    ['apps:changed', () => {
      void deps.refreshApps()
      void deps.refreshAppAgents()
    }],
    ['ai:keys-changed', () => {
      void deps.refreshKeyStatuses()
    }],
    ['gate:request', (request: unknown) => {
      deps.enqueueApproval(request)
    }],
    ['bridge:editor:open', (data: unknown) => {
      const path = isRecord(data) ? data.path : undefined
      if (typeof path === 'string') void deps.openFileInEditor(path)
    }],
    ['bridge:chat:send', (data: unknown) => {
      void deps.routeBridgeChatSend(data)
    }],
    ['bridge:workbench:open-work', (data: unknown) => {
      void deps.routeBridgeWorkbenchOpenWork(data)
    }],
    ['bridge:workbench:open-artifact', (data: unknown) => {
      void deps.routeBridgeWorkbenchOpenArtifact(data)
    }],
    ['menu:open-file', () => { void deps.openFileViaDialog() }],
    ['menu:new-document', () => { void deps.createUntitledInEditor() }],
    ['menu:save-file', () => { deps.handleSaveFile(false) }],
    ['menu:save-file-as', () => { deps.handleSaveFile(true) }],
    ['menu:export-document', () => { deps.openExportDialog() }],
    ['menu:open-recent', (path: unknown) => {
      if (typeof path === 'string') void deps.openFileInEditor(path)
    }],
    ['menu:clear-recent', () => { deps.clearRecentFiles() }],
    ['menu:close-tab', () => { deps.handleCloseTab() }],
    ['menu:settings', () => { deps.openSettings() }],
    ['menu:shortcuts', () => { deps.openShortcuts() }],
    ['menu:welcome', () => { deps.openWelcome() }],
    ['bridge:terminal:run', (data: unknown) => {
      const command = isRecord(data) ? data.command : undefined
      const reveal = isRecord(data) && typeof data.reveal === 'boolean' ? data.reveal : undefined
      if (typeof command === 'string') void deps.dispatchTerminalRun(command, reveal === undefined ? undefined : { reveal })
    }],
    ['package:job:event', deps.onPackageJobEvent],
    ['agent:session-event', deps.onAgentSessionEvent],
    ['subagent:event', (payload: unknown) => {
      const sessionId = isRecord(payload) ? payload.sessionId : undefined
      if (typeof sessionId === 'string') void deps.refreshSubagentSession(sessionId)
    }],
    ['team:update-available', (payload: unknown) => {
      const teamName = isRecord(payload) && typeof payload.teamName === 'string'
        ? payload.teamName
        : 'Your Team'
      deps.pushToast({
        kind: 'info',
        message: `${teamName} has an update`,
        detail: teamUpdateSummary(payload),
        actionLabel: 'Review',
        durationMs: null,
        action: () => { deps.openSettings('team') },
      })
    }],
    ['app:update-available', (payload: unknown) => {
      const version = updateVersion(payload)
      deps.pushToast({
        kind: 'info',
        message: `Mim ${version} is available`,
        detail: updateReleaseNotes(payload),
        actionLabel: 'Download',
        durationMs: null,
        action: async () => {
          try {
            await deps.downloadUpdate()
          } catch (error) {
            deps.pushToast({
              kind: 'error',
              message: 'Update download failed',
              detail: errorMessage(error),
            })
          }
        },
      })
    }],
    ['app:update-progress', () => {
      // Reserved for a future progress UI. The first updater flow keeps the
      // visible toast surface quiet until the update is downloaded.
    }],
    ['app:update-downloaded', (payload: unknown) => {
      const version = updateVersion(payload)
      deps.pushToast({
        kind: 'info',
        message: `Mim ${version} is ready to install`,
        actionLabel: 'Restart',
        durationMs: null,
        action: async () => {
          try {
            await deps.quitAndInstall()
          } catch (error) {
            deps.pushToast({
              kind: 'error',
              message: 'Update install failed',
              detail: errorMessage(error),
            })
          }
        },
      })
    }],
    ['app:update-error', () => {
      // Background update checks should not interrupt the user. Download and
      // install errors from explicit user actions are surfaced by their actions.
    }],
    ['editor:adopt-tab', (tab: unknown) => {
      deps.adoptTab?.(tab)
    }],
    ['popout:main-command', (data: unknown) => {
      if (!isRecord(data) || typeof data.type !== 'string') return
      if (data.type === 'terminal.send') {
        const payload = isRecord(data.payload) ? data.payload : undefined
        if (payload && typeof payload.text === 'string') {
          deps.dispatchTerminalSend?.(payload.text, typeof payload.language === 'string' ? payload.language : null)
        }
      } else if (data.type === 'chat.prepareDraft') {
        const payload = isRecord(data.payload) ? data.payload : undefined
        if (payload && typeof payload.text === 'string') {
          void deps.prepareChatDraft?.({
            targetSessionId: typeof payload.targetSessionId === 'string' ? payload.targetSessionId : null,
            text: payload.text,
            attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
            contextChips: Array.isArray(payload.contextChips) ? payload.contextChips : [],
          })
        }
      }
    }],
  ]

  for (const [channel, handler] of registrations) {
    kernel.on(channel, handler)
  }

  return () => {
    for (const [channel, handler] of registrations) {
      kernel.off(channel, handler)
    }
  }
}

function teamUpdateSummary(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.changes)) return undefined
  const names = payload.changes
    .map(change => isRecord(change) && typeof change.name === 'string' ? change.name : '')
    .filter(Boolean)
  if (names.length === 0) return undefined
  if (names.length <= 3) return names.join(names.length === 2 ? ' and ' : ', ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function updateVersion(payload: unknown): string {
  if (isRecord(payload) && typeof payload.version === 'string' && payload.version.length > 0) {
    return payload.version
  }
  return 'update'
}

function updateReleaseNotes(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const notes = payload.releaseNotes
  if (typeof notes === 'string' && notes.trim().length > 0) return notes
  if (Array.isArray(notes)) {
    const text = notes
      .map(item => isRecord(item) && typeof item.note === 'string' ? item.note : undefined)
      .filter((item): item is string => !!item && item.trim().length > 0)
      .join('\n')
    return text || undefined
  }
  return undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'Unknown update error'
}
