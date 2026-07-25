import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron'
import { basename, join, dirname, extname, relative, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { ApprovalMode, PermissionApprovalDecision } from '@main/security/gate.js'
import { cloneRepo } from '@main/git.js'
import { closeGuardDecision } from '@main/closeGuard.js'
import { installApplicationMenu } from '@main/menu.js'
import { initAutoUpdater, shouldInitializeAutoUpdater } from '@main/autoUpdater.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { createServer } from '@main/server/server.js'
import { createToolRegistry } from '@main/tools/registry.js'
import { createTraceLog } from '@main/trace/trace.js'
import { createTraceOutcomeTracker } from '@main/trace/outcomes.js'
import { resolveTelemetryConfig } from '@main/telemetry/config.js'
import { readTelemetryIdentity, setTelemetryIdentityEnabled } from '@main/telemetry/identity.js'
import { createTelemetry } from '@main/telemetry/telemetry.js'
import { loadUserConfig } from '@main/userConfig.js'
import { createPackageLoader } from '@main/packages/packages.js'
import { createPackageEnablementStore } from '@main/packages/packageEnablement.js'
import { createPackageRuntime } from '@main/packages/packageRuntime.js'
import { createPackageJobRunner } from '@main/packages/packageJobs.js'
import { registerFileTools } from '@main/tools/fs.js'
import { registerCommentTools } from '@main/tools/comments.js'
import { registerWorkspaceTools } from '@main/tools/workspace.js'
import { registerPackageTools } from '@main/tools/packages.js'
import { registerPackageRuntimeTools } from '@main/tools/packageRuntime.js'
import { registerBridgeTools } from '@main/tools/bridge.js'
import { clearEditorState, dropWindow as dropEditorWindow, findWindowIdForPath, noteWindowFocused, registerEditorStateTools, setMainWindowId, updateWindowEditorState } from '@main/tools/editorState.js'
import {
  readHistoryMaxBytes,
  readHistoryEnabled,
  readTraceCaptureContent,
  readTracePayloadMaxBytes,
  readTracePayloadRetentionDays,
  readTraceRetentionDays,
  readPersonalApprovalMode,
  registerSettingsTools,
} from '@main/tools/settings.js'
import { registerToolPolicyTools } from '@main/tools/toolPolicy.js'
import { registerToolchainTools } from '@main/tools/toolchain.js'
import { registerCodeTools } from '@main/tools/code.js'
import { registerSessionTools } from '@main/sessions.js'
import { registerSubagentTools } from '@main/tools/subagents.js'
import { createSubagentManager, type SubagentManager } from '@main/subagents/subagentManager.js'
import { chatProfile } from '@main/ai/aiRuntime.js'
import {
  continueRoutineRunInSession,
  createRoutineChatSession,
  registerRoutineTools,
  runRoutineOnce,
  startRoutineRun,
} from '@main/tools/routines.js'
import { createRoutineAutomation } from '@main/routines/automation.js'
import { loadRoutineCatalog } from '@main/routines/routines.js'
import { registerArchiveTools } from '@main/tools/archive.js'
import { registerAiTools } from '@main/ai/ai.js'
import { registerPtyTools, spawnPtyProcess, writePty } from '@main/pty.js'
import { createAgentSessions } from '@main/agents/agentSessions.js'
import { registerAgentTools } from '@main/tools/agents.js'
import { registerSearchTools } from '@main/tools/search.js'
import { registerGitTools } from '@main/tools/git.js'
import { registerAwarenessTools } from '@main/tools/awareness.js'
import { registerSyncTools } from '@main/tools/sync.js'
import { createBackgroundSync } from '@main/sync/backgroundSync.js'
import { registerTeamTools } from '@main/tools/team.js'
import { createTeamSource, resolveTeamCheckout, teamCheckoutPath } from '@main/team/teamSource.js'
import { syncTeamFilesMount } from '@main/team/teamFiles.js'
import { refreshLiveTeamContributions } from '@main/team/liveTeamRefresh.js'
import { registerTraceTools } from '@main/tools/trace.js'
import { createHistoryStore, type HistoryStore } from '@main/history/history.js'
import { registerHistoryTools } from '@main/tools/history.js'
import { registerDocumentTools } from '@main/tools/documents.js'
import { registerRenderTools } from '@main/tools/render.js'
import { registerExportTools } from '@main/tools/export.js'
import { registerReferencesTools } from '@main/tools/references.js'
import { renderDocumentHtmlToPdf, renderHtmlFileToPdf } from '@main/htmlPdf.js'
import { registerSkillTools } from '@main/tools/skills.js'
import { createNamedPackageToolSync, type NamedPackageToolSync } from '@main/packages/namedPackageTools.js'
import { createAgentContextContributionsProvider, createLocalPackageStatusProvider } from '@main/packages/packageContributions.js'
import { registerCoreAppTools } from '@main/tools/coreApps.js'
import { createAgentMounts } from '@main/ai/agentMounts.js'
import { registerLogbookTools } from '@main/tools/logbook.js'
import { registerWebTools } from '@main/tools/web.js'
import { createElectronLiveBrowserDriver } from '@main/web/liveBrowser.js'
import { renderUrlInHiddenWindow } from '@main/web/renderedBrowser.js'
import {
  clearBrowserSessionProfile,
  openBrowserSessionWindow,
  renderUrlInBrowserSession,
} from '@main/web/browserSession.js'
import {
  addBrowserSessionDomain,
  isBrowserSessionAllowed,
  readBrowserSessionSettings,
} from '@main/web/browserSessionSettings.js'
import { parseAllowedHttpUrl } from '@main/web/urlPolicy.js'
import { registerSlackTools } from '@main/integrations/slack/tools.js'
import { SlackIntegration } from '@main/integrations/slack/client.js'
import { createSlackSocketModeListener } from '@main/integrations/slack/listener.js'
import { registerGoogleTools } from '@main/integrations/google/tools.js'
import { SLACK_MCP_TOOL_SPECS, GOOGLE_MCP_TOOL_SPECS } from '@main/server/server.js'
import { registerTelemetryTools } from '@main/tools/telemetry.js'
import { createKeytarSecretStore } from '@main/integrations/secrets.js'
import { classifyWorkspace, scaffoldWorkspace } from '@main/workspace/workspaceContract.js'
import { setAgentContextTeamReader, setAgentContextAppsResolver, setAgentContextContributionsProvider, setAgentContextLocalPackagesProvider, type AgentContextApp } from '@main/ai/agentContext.js'
import { resolveBootWorkspace, recordLastWorkspace, isDefaultWorkspace } from '@main/workspace/workspaceBoot.js'
import {
  deleteMcpDiscoveryFile,
  writeMcpDiscoveryFile,
  type McpDiscovery,
} from '@main/mcp/discovery.js'
import { createWorkspaceFileWatcher } from '@main/workspace/workspaceFileWatcher.js'
import { toSlashPath, userHomeDir } from '@main/platform.js'
import {
  registerWindow,
  unregisterWindow,
  updateWindowDirtyState,
  totalDirtyCount,
  unionDirtyPaths,
  getWindowDirtyState,
  cascadePosition,
  popoutCloseGuardMessage,
  addReadyResolver,
  resolveReady,
  removeReadyResolver,
  resolveMenuTarget,
  normalizeSetEditedPayload,
} from '@main/windows/popoutWindows.js'
import {
  isAllowedExternalUrl,
  mainWindowCloseAction,
  restoreMainWindow,
  shouldOpenExternal,
  shouldQuitWhenAllWindowsClose,
} from '@main/windows/windowLifecycle.js'

const HOME_DIR = userHomeDir()
const AUTO_HISTORY_BASELINE_DELAY_MS = 2_000
const AUTO_HISTORY_BASELINE_OPTIONS = {
  maxScanned: 1_000,
  maxCaptured: 200,
  maxDurationMs: 750,
} as const
import { readAttachmentPaths } from '@main/attachments.js'
import { initSearchDb, closeSearchDb, rebuildIndex } from '@main/search/search.js'
import { getSystemPrompt } from '@main/ai/systemPrompt.js'
import { createPermissionGate, traceGateDecision } from '@main/security/gate.js'
import type { ToolRegistry } from '@main/tools/registry.js'

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let confirmAppQuit: (() => boolean) | null = null
const popoutWindows = new Map<number, BrowserWindow>()
let recentFiles: string[] = []
let workspaceFileWatcher: ReturnType<typeof createWorkspaceFileWatcher> | null = null
let telemetryShutdown: (() => Promise<void>) | null = null
let subagentShutdown: (() => Promise<void>) | null = null
let appUpdateInitialTimer: ReturnType<typeof setTimeout> | null = null
let appUpdateInterval: ReturnType<typeof setInterval> | null = null
let teamUpdateInterval: ReturnType<typeof setInterval> | null = null
let historyBaselineTimer: ReturnType<typeof setTimeout> | null = null
let routineTickerInterval: ReturnType<typeof setInterval> | null = null
let routineAutomationStop: (() => Promise<void>) | null = null
let packageJobsStop: (() => void) | null = null
let agentSessionsStop: (() => void) | null = null
let desktopServerClose: (() => void) | null = null
let backgroundSync: ReturnType<typeof createBackgroundSync> | null = null
let quitSyncPromise: Promise<void> | null = null
let quitSyncComplete = false
let ownedMcpDiscovery: McpDiscovery | null = null

function finishBackgroundSyncThenQuit(): void {
  if (quitSyncPromise) return
  quitSyncPromise = backgroundSync?.beforeClose() ?? Promise.resolve()
  void quitSyncPromise
    .catch(error => console.warn('[sync] final sync did not complete', error))
    .finally(() => {
      quitSyncComplete = true
      isQuitting = true
      app.quit()
    })
}

export const OPEN_DIRECTORY_DIALOG_PROPERTIES = ['openDirectory', 'createDirectory'] as const

export function configureLinuxCommandLine(
  commandLine: { appendSwitch(name: string, value?: string): void },
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'linux') return
  commandLine.appendSwitch('enable-features', 'UseOzonePlatform')
  commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

export function mainWindowChromeOptions(platform: NodeJS.Platform = process.platform) {
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hiddenInset' as const,
    // Lights at x=14 on a 20px pitch (zoom ends at x=66) sit on the collapsed
    // Navigator's chrome slab; the bridged pane header places the
    // expand-sidebar button on the next slot of that grid (x=74) via
    // NAVIGATOR_HEADER_BRIDGE_INSET.
    trafficLightPosition: { x: 14, y: 14 },
  }
}

function scheduleAutoHistoryBaseline(history: HistoryStore): void {
  if (historyBaselineTimer != null) clearTimeout(historyBaselineTimer)
  historyBaselineTimer = setTimeout(() => {
    historyBaselineTimer = null
    try { history.baselineWorkspace(AUTO_HISTORY_BASELINE_OPTIONS) } catch { /* local history baseline is best-effort */ }
  }, AUTO_HISTORY_BASELINE_DELAY_MS)
}

export function createMainWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    ...mainWindowChromeOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    }
  })
}

function createPopoutWindow(): BrowserWindow {
  // Gather existing popout bounds for cascade positioning
  const existingBounds: Array<{ x: number; y: number }> = []
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) {
      const bounds = win.getBounds()
      existingBounds.push({ x: bounds.x, y: bounds.y })
    }
  }
  const fallback = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { x: 100, y: 100 }
  const pos = cascadePosition(existingBounds, fallback)

  const win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 500,
    minHeight: 360,
    x: pos.x,
    y: pos.y,
    show: false,
    ...mainWindowChromeOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })
  return win
}

function closeAllPopouts(): void {
  for (const [id, win] of popoutWindows) {
    if (!win.isDestroyed()) {
      win.destroy()
    }
    popoutWindows.delete(id)
  }
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

/**
 * Send an event to ALL renderer windows (main + pop-outs).
 *
 * ONLY workspace-global state channels belong here — channels whose payload
 * every window must react to identically (file-system changes, workspace
 * identity, settings). Single-window or security-sensitive channels
 * (gate:request, package events, agent sessions, updater, bridge commands,
 * menu commands) stay on sendToRenderer to prevent double-handling.
 */
function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/**
 * Route a menu command to the correct window. Editor-scoped commands go to
 * the focused pop-out when one has focus; app-scoped commands always go to
 * the main window (and focus it so the surface is visible).
 */
function sendMenuCommand(command: string, ...args: unknown[]): void {
  const focused = BrowserWindow.getFocusedWindow()
  const focusedIsPopout = focused != null && popoutWindows.has(focused.webContents.id)
  const target = resolveMenuTarget(command, focusedIsPopout)

  if (target === 'focused' && focused && !focused.isDestroyed()) {
    focused.webContents.send(command, ...args)
  } else {
    sendToRenderer(command, ...args)
    // App-scoped commands target a surface that lives in the main window —
    // bring it forward so the user sees it.
    if (!focusedIsPopout) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
}

function rebuildApplicationMenu(): void {
  installApplicationMenu({
    platform: process.platform,
    appName: app.name,
    recentFiles,
    callbacks: {
      onNewDocument: () => sendMenuCommand('menu:new-document'),
      onOpenFile: () => sendMenuCommand('menu:open-file'),
      onSaveFile: () => sendMenuCommand('menu:save-file'),
      onSaveFileAs: () => sendMenuCommand('menu:save-file-as'),
      onExportDocument: () => sendMenuCommand('menu:export-document'),
      onOpenRecent: (path) => sendMenuCommand('menu:open-recent', path),
      onClearRecent: () => sendMenuCommand('menu:clear-recent'),
      onCloseTab: () => sendMenuCommand('menu:close-tab'),
      onOpenSettings: () => sendMenuCommand('menu:settings'),
      onShowShortcuts: () => sendMenuCommand('menu:shortcuts'),
      onShowWelcome: () => sendMenuCommand('menu:welcome'),
    },
  })
}

function scheduleAppUpdateChecks(updater: ReturnType<typeof initAutoUpdater>): void {
  clearAppUpdateTimers()

  const runCheck = () => {
    void updater.checkForUpdates().catch(() => {})
  }

  appUpdateInitialTimer = setTimeout(runCheck, 30_000)
  appUpdateInitialTimer.unref?.()
  appUpdateInterval = setInterval(runCheck, 4 * 60 * 60 * 1000)
  appUpdateInterval.unref?.()
}

function clearAppUpdateTimers(): void {
  if (appUpdateInitialTimer != null) {
    clearTimeout(appUpdateInitialTimer)
    appUpdateInitialTimer = null
  }
  if (appUpdateInterval != null) {
    clearInterval(appUpdateInterval)
    appUpdateInterval = null
  }
}

function scheduleTeamUpdateChecks(check: () => Promise<void>): void {
  if (teamUpdateInterval != null) clearInterval(teamUpdateInterval)
  teamUpdateInterval = setInterval(() => {
    void check().catch((error) => {
      console.warn('[team] update check failed', error)
    })
  }, 15 * 60 * 1000)
  teamUpdateInterval.unref?.()
}

function toWorkspaceRelative(workspace: string | null, absPath: string): string {
  if (!workspace) return absPath
  const rel = relative(workspace, absPath)
  if (rel.startsWith('..') || isAbsolute(rel)) return absPath
  return toSlashPath(rel)
}

function requireWorkspaceRelative(workspace: string | null, absPath: string): string {
  if (!workspace) throw new Error('No workspace open')
  const rel = relative(workspace, absPath)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Files must be saved inside the current workspace.')
  }
  return rel.replace(/\\/g, '/')
}

function resolveUserVisiblePath(workspace: string | null, path: string): string {
  if (isAbsolute(path) || !workspace) return path
  const resolved = resolve(workspace, path)
  const rel = relative(workspace, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path traversal outside workspace is not allowed')
  return resolved
}

function resolveSaveDialogDefaultPath(workspace: string, defaultPath: unknown): string {
  if (typeof defaultPath !== 'string' || defaultPath.trim().length === 0) {
    return join(workspace, 'Untitled.md')
  }
  const resolved = resolve(workspace, defaultPath)
  const rel = relative(workspace, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) return join(workspace, basename(defaultPath))
  return resolved
}

function uniqueDestination(dir: string, filename: string): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let candidate = join(dir, filename)
  let index = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}-${index}${ext}`)
    index++
  }
  return candidate
}

function extnameLower(path: string): string {
  return extname(path).toLowerCase().replace(/^\./, '')
}

async function latestAssistantReply(tools: ToolRegistry, sessionId: string): Promise<string | null> {
  const session = await tools.call('session.get', { id: sessionId }, { actor: 'system' }) as { messages?: unknown[] }
  const messages = Array.isArray(session.messages) ? session.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isRecord(message) || message.role !== 'assistant') continue
    const text = assistantMessageText(message)
    if (text) return text
  }
  return null
}

function assistantMessageText(message: Record<string, unknown>): string | null {
  const parts = Array.isArray(message.parts) ? message.parts : []
  const partText = parts
    .map(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim()
  if (partText) return partText
  return typeof message.content === 'string' && message.content.trim() ? message.content.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function boot(): Promise<void> {
  let tools!: ToolRegistry
  const appVersion = app.getVersion()
  const telemetryConfig = resolveTelemetryConfig({ home: HOME_DIR })
  let telemetryIdentity = telemetryConfig.disabled
    ? null
    : readTelemetryIdentity({ home: HOME_DIR })
  const telemetry = createTelemetry({
    appVersion,
    platform: telemetryConfig.platform,
    runtime: 'electron',
    anonId: telemetryIdentity?.anonId ?? 'disabled',
    enabled: (telemetryIdentity?.enabled ?? false) && !telemetryConfig.disabled,
    locked: telemetryConfig.locked,
    endpoint: telemetryConfig.endpoint,
    onEnabledChange: (enabled) => {
      telemetryIdentity = setTelemetryIdentityEnabled(enabled, { home: HOME_DIR })
    },
  })
  telemetryShutdown = () => telemetry.shutdown()
  // Principal is the human identity behind every actor in the trace stream.
  // Single-user today (from ~/.mim/config.yaml), but stamped per event because
  // identity cannot be retrofitted once multi-user/hosted deployments exist.
  const traceLog = createTraceLog({
    sinks: [telemetry.createTelemetrySink()],
    getPrincipal: () => {
      const user = loadUserConfig().user
      return user.email ?? user.name
    },
    getRetentionDays: () => readTraceRetentionDays(tools?.getWorkspacePath() ?? null),
    getPayloadRetentionDays: () => readTracePayloadRetentionDays(tools?.getWorkspacePath() ?? null),
    getPayloadMaxBytes: () => readTracePayloadMaxBytes(tools?.getWorkspacePath() ?? null),
  })
  let server: Awaited<ReturnType<typeof createServer>> | null = null
  let packages: Awaited<ReturnType<typeof createPackageLoader>> | null = null
  let namedPackageTools: NamedPackageToolSync | null = null
  let agentMountsRef: ReturnType<typeof createAgentMounts> | null = null
  let subagentManagerRef: SubagentManager | null = null
  let packageEnablement: ReturnType<typeof createPackageEnablementStore> | null = null
  let appUpdater: ReturnType<typeof initAutoUpdater> | null = null
  let routineAutomation: ReturnType<typeof createRoutineAutomation> | null = null
  let slackListener: ReturnType<typeof createSlackSocketModeListener> | null = null
  let routineDefinitionRefreshTimer: ReturnType<typeof setTimeout> | null = null

  const teamSource = createTeamSource({ homeDir: HOME_DIR })

  async function syncWorkspaceTeamMount(ws: string): Promise<void> {
    let team = null
    try {
      team = await teamSource.open()
    } catch {
      // A disconnected or stopped Team appears absent; Project opening remains
      // independent from Team Git availability.
    }
    try {
      syncTeamFilesMount(ws, team)
    } catch {
      // Mount reconciliation is best-effort and must not block Project open.
    }
  }

  setAgentContextTeamReader(() => {
    if (!loadUserConfig(HOME_DIR).team?.repository) return null
    try {
      const team = resolveTeamCheckout(teamCheckoutPath(HOME_DIR))
      return { name: team.name, filesPath: '.mim/team/files' }
    } catch {
      return null
    }
  })

  function updateRoutineApprovalSession(sessionId: string | undefined, routineId: string | undefined, data: Record<string, unknown>): void {
    if (!sessionId || !routineId) return
    void tools.call('session.update', { id: sessionId, ...data }, { actor: 'system' }).catch(() => {})
  }

  const gate = createPermissionGate({
    getApprovalMode: () => readApprovalMode(),
    getWorkspacePath: () => tools.getWorkspacePath(),
    getPackagePermissions: (packageId) => packages?.get(packageId)?.manifest.permissions,
    getDynamicToolPolicy: (name) => namedPackageTools?.getPolicy(name),
    resolveSavedBrowserSessionGrant: (toolName, params) => {
      if ((toolName !== 'web.read' && toolName !== 'web.live.open') || params.stateful !== true || typeof params.url !== 'string') return null
      const ws = tools.getWorkspacePath()
      if (!ws) return null
      try {
        const parsed = parseAllowedHttpUrl(params.url)
        const settings = readBrowserSessionSettings(ws)
        const match = isBrowserSessionAllowed(parsed.href, settings.allowedDomains)
        return { domain: match.host, granted: settings.enabled && match.allowed }
      } catch {
        return null
      }
    },
    grantSavedBrowserSessionDomain: (grant) => {
      const ws = tools.getWorkspacePath()
      if (!ws) throw new Error('No workspace open')
      addBrowserSessionDomain(ws, grant.domain)
    },
    onApprovalRequested: (request) => {
      if (request.sessionId && request.subagentRootSessionId) {
        void subagentManagerRef?.markApproval(request.sessionId, 'needs-approval')
      }
      updateRoutineApprovalSession(request.sessionId, request.routineId, { routineStatus: 'needs-approval' })
    },
    onApprovalResolved: (request, decision) => {
      if (request.sessionId && request.subagentRootSessionId) {
        void subagentManagerRef?.markApproval(
          request.sessionId,
          'working',
        )
      }
      if (decision.approved) {
        updateRoutineApprovalSession(request.sessionId, request.routineId, { routineStatus: 'working', routineError: '' })
      } else {
        updateRoutineApprovalSession(request.sessionId, request.routineId, {
          routineStatus: 'error',
          routineError: 'Approval denied',
          routineCompletedAt: new Date().toISOString(),
        })
      }
    },
    sendApprovalRequest: (request) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      mainWindow.webContents.send('gate:request', request)
      return true
    },
    recordDecision: (event) => traceGateDecision(traceLog, event),
  })
  const traceOutcomes = createTraceOutcomeTracker({
    trace: traceLog,
    getWorkspacePath: () => tools?.getWorkspacePath() ?? null,
  })
  const history = createHistoryStore({
    getWorkspacePath: () => tools?.getWorkspacePath() ?? null,
    isEnabled: () => readHistoryEnabled(tools?.getWorkspacePath() ?? null),
    getMaxBytes: () => readHistoryMaxBytes(tools?.getWorkspacePath() ?? null),
  })
  tools = createToolRegistry(traceLog, gate, {
    outcomes: traceOutcomes,
    history: history.toolObserver(),
    getCaptureContent: () => readTraceCaptureContent(tools?.getWorkspacePath() ?? null),
    onMutation: path => backgroundSync?.changed(path),
  })
  workspaceFileWatcher = createWorkspaceFileWatcher({
    emit: (channel, payload) => {
      broadcastToRenderers(channel, payload)
      if (payload.changes.some(change => change.path.startsWith('routines/'))) {
        if (routineDefinitionRefreshTimer) clearTimeout(routineDefinitionRefreshTimer)
        routineDefinitionRefreshTimer = setTimeout(() => {
          routineDefinitionRefreshTimer = null
          void Promise.all([
            routineAutomation?.refresh(),
            slackListener?.refresh(),
          ]).then(() => {
            broadcastToRenderers('routines:changed', {})
            server?.broadcast('routines:changed', {})
          }).catch((err) => {
            console.error('[routines] definition refresh failed', err)
          })
        }, 50)
      }
      for (const change of payload.changes) {
        traceOutcomes.observeFileChange(change)
        history.observeFileChange(change)
      }
    },
  })

  registerFileTools(tools, {
    openNativeFile: (path) => shell.openPath(path),
    trashItem: (path) => shell.trashItem(path),
    onUserTrashed: (paths) => broadcastToRenderers('workspace:files-trashed', { paths }),
  })
  registerCommentTools(tools, {
    isDirtyOpenPath: (path) => unionDirtyPaths().has(path),
  })
  registerWorkspaceTools(tools)
  registerBridgeTools(tools, {
    sendToMainWindow: (channel, data) => sendToRenderer(channel, data),
    routeEditorOpen: (path) => {
      const popoutId = findWindowIdForPath(path)
      if (popoutId == null) return false
      const popout = popoutWindows.get(popoutId)
      if (!popout || popout.isDestroyed()) return false
      popout.webContents.send('bridge:editor:open', { path })
      popout.show()
      popout.focus()
      return true
    },
  })
  registerEditorStateTools(tools)
  registerSettingsTools(tools, {
    onChange: () => broadcastToRenderers('settings:changed'),
  })
  registerToolPolicyTools(tools)
  registerToolchainTools(tools)
  registerCodeTools(tools, {
    sendTerminalCommand: (command: string) => {
      sendToRenderer('bridge:terminal:run', { command, reveal: true })
    },
  })
  // Registered here (not a tools/ module) because it needs the Electron app
  // handle; the headless server never has these versions to report.
  tools.register({
    name: 'app.info',
    description: 'App version, updater state, and runtime info for Settings and diagnostics',
    execute: async () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      update: appUpdater?.status() ?? { state: 'unavailable' },
    }),
  })
  registerSessionTools(tools)
  subagentManagerRef = createSubagentManager({
    tools,
    cancelApprovals: sessionId => gate.cancelSession(sessionId),
    getAgentProfile: async (agentId) => {
      if (!agentId) return chatProfile
      if (!agentMountsRef) throw new Error('Agent profiles are not available until a workspace is open')
      return agentMountsRef.resolveProfile(agentId)
    },
    emit: (event) => {
      sendToRenderer('subagent:event', event)
      server?.broadcast('subagent:event', event)
    },
  })
  registerSubagentTools(tools, subagentManagerRef)
  subagentShutdown = () => subagentManagerRef?.dispose() ?? Promise.resolve()
  const packageSecretStore = createKeytarSecretStore()
  slackListener = createSlackSocketModeListener({
    getWorkspacePath: () => tools.getWorkspacePath(),
    getRoutines: () => {
      const ws = tools.getWorkspacePath()
      if (!ws) return []
      return loadRoutineCatalog(ws, { knownTools: new Set(tools.list().map(tool => tool.name)) }).routines
    },
    runRoutine: (routine, context) => runRoutineOnce(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
    startRoutine: (routine, context) => startRoutineRun(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
    continueRoutine: (routine, context, thread) =>
      continueRoutineRunInSession(tools, routine, context, thread.sessionId, { getAgentMounts: () => agentMountsRef }),
    getSessionReplyText: (sessionId) => latestAssistantReply(tools, sessionId),
    slack: new SlackIntegration({ secrets: packageSecretStore }),
    trace: traceLog,
  })
  registerRoutineTools(tools, {
    getAgentMounts: () => agentMountsRef,
    runRoutine: (routine, context) => runRoutineOnce(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
    startRoutine: (routine, context) => createRoutineChatSession(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
    secrets: packageSecretStore,
    onChange: async () => {
      await routineAutomation?.refresh()
      await slackListener?.refresh()
      broadcastToRenderers('routines:changed', {})
      server?.broadcast('routines:changed', {})
    },
  })
  registerAiTools(tools, (channel) => {
    broadcastToRenderers(channel)
    server?.broadcast(channel, {})
  })
  registerPtyTools(tools)
  registerSearchTools(tools)
  registerGitTools(tools)
  registerAwarenessTools(tools)
  registerSyncTools(tools)
  registerTeamTools(tools, {
    source: teamSource,
    onChanged: async () => {
      await refreshLiveTeamContributions({
        syncMount: async () => {
          const workspace = tools.getWorkspacePath()
          if (workspace) await syncWorkspaceTeamMount(workspace)
        },
        rescanApps: async () => { await packages?.rescan() },
        syncNamedTools: async () => { await namedPackageTools?.sync() },
        refreshRoutines: async () => { await routineAutomation?.refresh() },
        refreshSlack: async () => { await slackListener?.refresh() },
        notifyRoutines: () => {
          broadcastToRenderers('routines:changed', {})
          server?.broadcast('routines:changed', {})
        },
      })
    },
    emit: (channel, payload) => {
      mainWindow?.webContents.send(channel, payload)
      server?.broadcast(channel, payload ?? {})
    },
  })
  backgroundSync = createBackgroundSync({
    syncProject: async () => {
      const current = await tools.call('sync.status', {}, { actor: 'system' }) as {
        mode?: string
        state?: string
        gitAvailable?: boolean
        git?: boolean
        remote?: string | null
        retryable?: boolean
        message?: string
      }
      if (
        current.mode !== 'managed'
        || !current.gitAvailable
        || !current.git
        || !current.remote
        || (current.state === 'stopped' && !current.retryable)
      ) return
      const result = await tools.call('sync.now', {}, { actor: 'system' }) as {
        state?: string
        retryable?: boolean
        message?: string
      }
      if (result.state === 'stopped' && result.retryable) {
        throw new Error(result.message ?? 'Project sync is waiting to retry')
      }
      broadcastToRenderers('sync:changed', { scope: 'project' })
    },
    syncTeam: async () => {
      const current = await tools.call('team.status', {}, { actor: 'system' }) as Awaited<ReturnType<typeof teamSource.status>>
      if (
        !current.repository
        || current.state === 'invalid'
        || (current.state === 'stopped' && !current.retryable)
      ) return
      if (current.dirty || current.ahead > 0) {
        const published = await teamSource.publish()
        if (published.retryable) {
          throw new Error(published.message)
        }
      }
      await tools.call('team.check', {}, { actor: 'system' })
    },
    onError: (scope, error) => {
      console.warn(`[sync] ${scope} will retry`, error)
      broadcastToRenderers('sync:changed', { scope })
    },
  })
  scheduleTeamUpdateChecks(async () => {
    const current = await teamSource.status()
    if (
      !current.repository
      || current.state === 'invalid'
      || (current.state === 'stopped' && !current.retryable)
    ) return
    await tools.call('team.check', {}, { actor: 'system' })
  })
  registerTraceTools(tools)
  registerHistoryTools(tools, history)
  registerDocumentTools(tools)
  registerRenderTools(tools, { render: renderHtmlFileToPdf })
  registerExportTools(tools, { renderPdf: renderDocumentHtmlToPdf })
  registerReferencesTools(tools)
  registerSkillTools(tools, {
    getPackageSkillRoots: () =>
      (packages?.list() ?? [])
        .filter(p => packageEnablement?.isEnabled(p))
        .map(p => ({
          packageId: p.manifest.id,
          packageName: p.manifest.name,
          dir: join(p.dir, 'skills'),
        }))
        .filter(p => existsSync(p.dir)),
    emit: (channel) => {
      mainWindow?.webContents.send(channel)
      server?.broadcast(channel, {})
    },
  })
  registerLogbookTools(tools)
  registerWebTools(tools, {
    renderRenderedPage: renderUrlInHiddenWindow,
    renderSavedBrowserSessionPage: renderUrlInBrowserSession,
    openSavedBrowserSession: openBrowserSessionWindow,
    clearSavedBrowserSessionProfile: clearBrowserSessionProfile,
    liveBrowser: createElectronLiveBrowserDriver({
      getWorkspacePath: () => tools.getWorkspacePath(),
    }),
  })
  const slackMcp = registerSlackTools(tools, { secrets: packageSecretStore, listener: slackListener })
  const googleMcp = registerGoogleTools(tools, {
    openExternal: (url) => shell.openExternal(url),
  })
  void slackMcp.refresh()
  void googleMcp.refresh()
  registerTelemetryTools(tools, telemetry)
  telemetry.track('app_open', {
    appVersion,
    platform: telemetryConfig.platform,
    runtime: 'electron',
  })
  tools.register({
    name: 'documents.pickReviewFile',
    description: 'Open a native picker for a DOCX review document and return a workspace-relative path. External files are copied into inputs/.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const workspace = tools.getWorkspacePath()
      if (!workspace) throw new Error('No workspace open')
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        defaultPath: workspace,
        filters: [{ name: 'Word documents', extensions: ['docx'] }],
      })
      if (result.canceled || !result.filePaths[0]) return { cancelled: true }
      const selected = result.filePaths[0]
      const rel = relative(workspace, selected)
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return {
          cancelled: false,
          path: rel.replace(/\\/g, '/'),
          filename: basename(selected),
          size: statSync(selected).size,
          copied: false,
        }
      }

      const inputsDir = join(workspace, 'inputs')
      mkdirSync(inputsDir, { recursive: true })
      const destination = uniqueDestination(inputsDir, basename(selected))
      copyFileSync(selected, destination)
      return {
        cancelled: false,
        path: toSlashPath(relative(workspace, destination)),
        filename: basename(selected),
        size: statSync(destination).size,
        copied: true,
      }
    },
  })
  tools.register({
    name: 'documents.pickImportFile',
    description: 'Open a native picker for an importable document and return a workspace-relative path. External files are copied into inputs/.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const workspace = tools.getWorkspacePath()
      if (!workspace) throw new Error('No workspace open')
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        defaultPath: workspace,
        filters: [
          { name: 'Importable documents', extensions: ['docx', 'xlsx', 'xlsm', 'pdf', 'bib'] },
          { name: 'Word documents', extensions: ['docx'] },
          { name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] },
          { name: 'PDF documents', extensions: ['pdf'] },
          { name: 'BibTeX libraries', extensions: ['bib'] },
        ],
      })
      if (result.canceled || !result.filePaths[0]) return { cancelled: true }
      const selected = result.filePaths[0]
      const rel = relative(workspace, selected)
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return {
          cancelled: false,
          path: toSlashPath(rel),
          filename: basename(selected),
          extension: extnameLower(selected),
          size: statSync(selected).size,
          copied: false,
        }
      }

      const inputsDir = join(workspace, 'inputs')
      mkdirSync(inputsDir, { recursive: true })
      const destination = uniqueDestination(inputsDir, basename(selected))
      copyFileSync(selected, destination)
      return {
        cancelled: false,
        path: toSlashPath(relative(workspace, destination)),
        filename: basename(selected),
        extension: extnameLower(selected),
        size: statSync(destination).size,
        copied: true,
      }
    },
  })

  // Restore the last-opened workspace (or create+open a default). This always
  // yields a real, existing workspace path so sessions load on every launch.
  const bootWorkspace = resolveBootWorkspace(HOME_DIR)
  await tools.call('workspace.open', { path: bootWorkspace }, { actor: 'system' })
  await subagentManagerRef.reconcile()
  telemetry.track('workspace_open')

  // Auto-initialize the default workspace the app itself created, so the
  // InitWorkspaceBanner never nags about a folder Mim made. User-opened
  // external folders still get the banner with its plain-language guidance.
  if (isDefaultWorkspace(HOME_DIR, bootWorkspace)) {
    try {
      const status = classifyWorkspace(bootWorkspace)
      if (!status.initialized) {
        scaffoldWorkspace(bootWorkspace, { name: basename(bootWorkspace) })
      }
    } catch { /* auto-init non-fatal — the banner remains as fallback */ }
  }

  await workspaceFileWatcher.setWorkspace(bootWorkspace)
  scheduleAutoHistoryBaseline(history)
  await syncWorkspaceTeamMount(bootWorkspace)
  void backgroundSync.open()
  recordLastWorkspace(HOME_DIR, bootWorkspace)
  try { initSearchDb(bootWorkspace) } catch { /* search db init non-fatal */ }
  // Defer FTS reindex so the window paints before scanning session files.
  setImmediate(() => { try { rebuildIndex(bootWorkspace) } catch { /* search index non-fatal */ } })

  packages = await createPackageLoader(tools)
  packageEnablement = createPackageEnablementStore({
    getWorkspacePath: () => tools.getWorkspacePath(),
  })
  routineAutomation = createRoutineAutomation({
    getWorkspacePath: () => tools.getWorkspacePath(),
    runRoutine: (routine, context) => runRoutineOnce(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
    knownTools: () => new Set(tools.list().map(tool => tool.name)),
    secrets: packageSecretStore,
    trace: traceLog,
  })
  routineAutomationStop = async () => {
    await routineAutomation?.stop()
    await slackListener?.stop()
  }
  const packageRuntime = createPackageRuntime({
    packages,
    enablement: packageEnablement,
    tools,
    trace: traceLog,
    secrets: packageSecretStore,
  })
  const agentMounts = createAgentMounts({ runtime: packageRuntime, packages, tools })
  agentMountsRef = agentMounts
  namedPackageTools = createNamedPackageToolSync({ runtime: packageRuntime, tools, packages })
  setAgentContextContributionsProvider(createAgentContextContributionsProvider({ runtime: packageRuntime, packages }))
  setAgentContextLocalPackagesProvider(createLocalPackageStatusProvider({ runtime: packageRuntime, packages, enablement: packageEnablement }))
  const packageJobs = createPackageJobRunner({
    runtime: packageRuntime,
    trace: traceLog,
    getWorkspacePath: () => tools.getWorkspacePath(),
    emit: (event, data) => {
      server?.broadcast(event, data)
      mainWindow?.webContents.send(event, data)
    },
  })
  packageJobsStop = () => packageJobs.cancelAll()
  packageJobs.reconcileStaleRuns()
  registerPackageTools(tools, packages, packageEnablement, {
    invalidate: (id) => packageRuntime.invalidate(id),
    syncNamedTools: () => namedPackageTools?.sync() ?? Promise.resolve(),
    emit: (channel, payload) => {
      mainWindow?.webContents.send(channel, payload)
      server?.broadcast(channel, payload ?? {})
    },
  })
  registerCoreAppTools(tools, {
    packages,
    enablement: packageEnablement,
    invalidate: (id) => { packageRuntime.invalidate(id); void namedPackageTools?.sync() },
    emit: (channel) => {
      broadcastToRenderers(channel)
      server?.broadcast(channel, {})
    },
    agentMounts,
  })

  setAgentContextAppsResolver((): AgentContextApp[] => {
    const apps: AgentContextApp[] = []
    for (const pkg of packages.list()) {
      apps.push({
        id: pkg.manifest.id,
        enabled: packageEnablement.isEnabled(pkg),
      })
    }
    return apps.sort((a, b) => a.id.localeCompare(b.id))
  })

  registerPackageRuntimeTools(tools, packages, packageRuntime, packageJobs, {
    secretStore: packageSecretStore,
  })
  await namedPackageTools.sync()
  registerArchiveTools(tools, packageJobs)

  const agentSessions = createAgentSessions({
    getWorkspacePath: () => tools.getWorkspacePath(),
    spawnPty: spawnPtyProcess,
    getMcpServerPort: () => {
      if (!server) throw new Error('MCP server is not initialized')
      return server.port
    },
    createMcpToken: (sessionId) => {
      if (!server) throw new Error('MCP server is not initialized')
      return server.createMcpToken(sessionId)
    },
    revokeMcpToken: (token) => {
      server?.revokeMcpToken(token)
    },
    emit: (event, data) => {
      server?.broadcast(event, data)
      mainWindow?.webContents.send(event, data)
    },
    generateTitle: (scrollbackText) => {
      if (!server) return Promise.resolve(null)
      return server.generateTaskLabel(scrollbackText)
    },
  })
  agentSessionsStop = () => agentSessions.stopAll()
  agentSessions.reconcileStaleSessions()
  registerAgentTools(tools, { sessions: agentSessions })

  tools.register({
    name: 'system.prompt',
    description: 'Get the system prompt for the AI chat',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ prompt: getSystemPrompt(tools.getWorkspacePath() ?? undefined) })
  })

  server = await createServer(tools, packages, {
    getNamedMcpTools: () => {
      const specs: Array<{ name: string; mimName: string; description: string }> = []
      const seen = new Set<string>()
      const pushSpec = (name: string) => {
        if (seen.has(name)) return
        seen.add(name)
        const tool = tools.get(name)
        if (tool) specs.push({ name: name.replace(/\./g, '_'), mimName: name, description: tool.description })
      }
      for (const name of namedPackageTools?.ownedNames() ?? []) pushSpec(name)
      if (slackMcp.connected) specs.push(...SLACK_MCP_TOOL_SPECS)
      if (googleMcp.connected) specs.push(...GOOGLE_MCP_TOOL_SPECS)
      return specs
    },
    agentMounts,
    handleRoutineWebhook: (name, delivery) =>
      routineAutomation?.handleWebhook(name, delivery) ?? Promise.resolve({
        status: 404,
        ok: false,
        error: 'Routine automation is not available',
      }),
  })
  desktopServerClose = () => {
    server?.close()
    server = null
  }
  const discovery = {
    port: server.port,
    token: server.createMcpToken('mcp'),
  }
  try {
    writeMcpDiscoveryFile(discovery, HOME_DIR)
    ownedMcpDiscovery = discovery
  } catch (err) {
    console.error('[mcp] Failed to write discovery file', err)
  }
  await routineAutomation?.start()
  await slackListener?.refresh().catch((err) => {
    console.error('[slack] listener refresh failed', err)
  })
  await routineAutomation?.tick().catch((err) => {
    console.error('[routines] initial tick failed', err)
  })
  if (routineTickerInterval != null) clearInterval(routineTickerInterval)
  routineTickerInterval = setInterval(() => {
    void routineAutomation?.tick().catch((err) => {
      console.error('[routines] tick failed', err)
    })
  }, 60_000)
  routineTickerInterval.unref?.()
  async function openWorkspacePath(path: string): Promise<string> {
    await subagentManagerRef?.interruptActive()
    await tools.call('workspace.open', { path }, { actor: 'user' })
    await subagentManagerRef?.reconcile()
    telemetry.track('workspace_open')
    // Drop the previous workspace's tab snapshot; the remounted editor re-pushes.
    clearEditorState()
    await workspaceFileWatcher?.setWorkspace(path)
    scheduleAutoHistoryBaseline(history)
    await syncWorkspaceTeamMount(path)
    void backgroundSync?.open()
    recordLastWorkspace(HOME_DIR, path)
    try { closeSearchDb(); initSearchDb(path) } catch { /* search db init non-fatal */ }
    // Defer FTS reindex so workspace switch feels instant.
    setImmediate(() => { try { rebuildIndex(path) } catch { /* search index non-fatal */ } })
    await packages!.rescan()
    packageRuntime.invalidate()
    await namedPackageTools?.sync()
    await routineAutomation?.refresh()
    await routineAutomation?.tick().catch((err) => {
      console.error('[routines] workspace tick failed', err)
    })
    await slackListener?.refresh().catch((err) => {
      console.error('[slack] workspace listener refresh failed', err)
    })
    mainWindow?.webContents.send('packages:changed', packages!.list())
    // Close all pop-outs before broadcasting the workspace change — they are
    // workspace-scoped and would show stale content. Each popout's own close
    // guard applies; if a guard is cancelled, that popout survives (acceptable).
    closeAllPopouts()
    broadcastToRenderers('workspace:changed', path)
    // Notify package iframes via WebSocket so they reload their data
    server?.broadcast('workspace:changed', { path })
    return path
  }

  ipcMain.handle('kernel:open-workspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: [...OPEN_DIRECTORY_DIALOG_PROPERTIES]
    })
    if (!result.canceled && result.filePaths[0]) {
      return openWorkspacePath(result.filePaths[0])
    }
    return null
  })

  ipcMain.handle('kernel:open-workspace-path', async (_event, path: string) => {
    if (typeof path !== 'string' || path.length === 0) return null
    return openWorkspacePath(path)
  })

  ipcMain.handle('kernel:watch-workspace-file', async (_event, path: string) => ({
    watching: typeof path === 'string' ? workspaceFileWatcher?.watchFile(path) === true : false,
  }))

  ipcMain.handle('kernel:unwatch-workspace-file', async (_event, path: string) => ({
    unwatched: typeof path === 'string' ? await workspaceFileWatcher?.unwatchFile(path) === true : false,
  }))

  ipcMain.handle('kernel:open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: [...OPEN_DIRECTORY_DIALOG_PROPERTIES]
    })
    if (!result.canceled && result.filePaths[0]) {
      return result.filePaths[0]
    }
    return null
  })

  // Open a single file for the editor. Returns a workspace-relative path when the
  // selection lives inside the workspace (so fs.read and tab de-duplication stay
  // consistent with the rest of the app), otherwise the absolute path.
  ipcMain.handle('kernel:open-file-dialog', async () => {
    const workspace = tools.getWorkspacePath()
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      defaultPath: workspace ?? undefined,
    })
    if (result.canceled || !result.filePaths[0]) return null
    return toWorkspaceRelative(workspace, result.filePaths[0])
  })

  ipcMain.handle('kernel:save-file-dialog', async (
    _event,
    options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }>; allowAbsolutePath?: boolean } = {},
  ) => {
    const workspace = tools.getWorkspacePath()
    if (!workspace) throw new Error('No workspace open')
    const filters = Array.isArray(options.filters) && options.filters.length > 0
      ? options.filters.filter(f => f && typeof f.name === 'string' && Array.isArray(f.extensions))
      : [
          { name: 'Text and Markdown', extensions: ['md', 'markdown', 'txt'] },
          { name: 'All Files', extensions: ['*'] },
        ]
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: resolveSaveDialogDefaultPath(workspace, options.defaultPath),
      filters,
    })
    if (result.canceled || !result.filePath) return null
    if (options.allowAbsolutePath) return result.filePath
    return requireWorkspaceRelative(workspace, result.filePath)
  })

  // The renderer owns the canonical recent-files list (persisted per workspace);
  // it pushes updates here so the native "Open Recent" menu stays in sync.
  ipcMain.handle('kernel:set-recent-files', async (_event, files: unknown) => {
    recentFiles = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : []
    rebuildApplicationMenu()
    return { ok: true }
  })

  ipcMain.handle('kernel:pick-attachments', async (_event, options: { kind?: string } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: options.kind === 'image'
        ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
        : undefined,
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { attachments: [] }
    }
    return { attachments: readAttachmentPaths(result.filePaths, { workspacePath: tools.getWorkspacePath() }) }
  })

  ipcMain.handle('kernel:read-attachments', async (_event, paths: string[]) => {
    return {
      attachments: readAttachmentPaths(
        paths.filter(path => typeof path === 'string' && path.length > 0),
        { workspacePath: tools.getWorkspacePath() },
      ),
    }
  })

  ipcMain.handle('kernel:create-directory', async (_event, dirPath: string) => {
    if (existsSync(dirPath)) {
      throw new Error('A folder already exists at this location.')
    }
    mkdirSync(dirPath, { recursive: true })
    return { created: dirPath }
  })

  ipcMain.handle('kernel:git-clone', async (_event, url: string, target: string, token?: string) => {
    return cloneRepo(url, target, token)
  })

  ipcMain.handle('kernel:open-native-file', async (_event, path: string) => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('Path is required')
    const resolved = resolveUserVisiblePath(tools.getWorkspacePath(), path)
    const stat = statSync(resolved)
    if (!stat.isFile()) throw new Error(`Not a file: ${path}`)
    const error = await shell.openPath(resolved)
    if (error) throw new Error(error)
    return { opened: path }
  })

  ipcMain.handle('kernel:reveal-in-finder', async (_event, dirPath: string) => {
    shell.showItemInFolder(resolveUserVisiblePath(tools.getWorkspacePath(), dirPath))
  })

  ipcMain.handle('kernel:open-external', async (_event, url: string) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url)
  })

  // Universal tool dispatch — renderer calls kernel.call() via IPC.
  // The renderer is always 'user': only main-process internals (AI runtime,
  // package runtime) may set actor to 'ai' or 'package'. Accepting those
  // from IPC would let XSS in the renderer bypass the approval gate.
  ipcMain.handle('kernel:call', async (
    _event,
    tool: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string } = {},
  ) => {
    const result = await tools.call(tool, params, {
      actor: 'user',
      sessionId: typeof options.sessionId === 'string' ? options.sessionId : undefined,
    })
    return result
  })
  ipcMain.handle('gate:respond', async (
    _event,
    requestId: string,
    decision: PermissionApprovalDecision,
  ) => gate.respond(requestId, decision))
  ipcMain.handle('gate:cancel-session', async (
    _event,
    sessionId: string,
  ) => gate.cancelSession(sessionId))

  // Fast-path pty input — renderer keystrokes bypass the tool registry.
  ipcMain.on('pty:input', (_event, id: number, data: string) => writePty(id, data))

  ipcMain.handle('kernel:port', () => server!.port)
  ipcMain.handle('kernel:ai-token', () => server!.shellToken)
  ipcMain.handle('kernel:packages', () => packages.list())
  ipcMain.handle('kernel:workspace', () => tools.getWorkspacePath())
  ipcMain.handle('kernel:package-launch-url', (_event, packageId: string, viewId?: string) =>
    server!.createPackageLaunchUrl(packageId, viewId),
  )
  ipcMain.handle('kernel:download-update', async () => {
    if (!appUpdater) throw new Error('App updates are unavailable in this build')
    await appUpdater.downloadUpdate()
  })
  ipcMain.handle('kernel:check-for-updates', async () => {
    if (!appUpdater) throw new Error('App updates are unavailable in this build')
    await appUpdater.checkForUpdates()
  })
  ipcMain.handle('kernel:quit-and-install', async () => {
    if (!appUpdater) throw new Error('App updates are unavailable in this build')
    appUpdater.quitAndInstall()
  })

  packages.onChange(() => {
    packageRuntime.invalidate()
    void namedPackageTools?.sync()
    mainWindow?.webContents.send('packages:changed', packages.list())
  })

  mainWindow = createMainWindow()

  if (shouldInitializeAutoUpdater({
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
  })) {
    appUpdater = initAutoUpdater({
      send: (channel, data) => {
        mainWindow?.webContents.send(channel, data)
      },
      broadcast: (channel, data) => {
        server?.broadcast(channel, data)
      },
    })
    scheduleAppUpdateChecks(appUpdater)
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternal(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // ── Per-window registration ──
  // Register the main window so its dirty state and editor snapshot feed the
  // aggregated quit guard and editor.state tool. Pop-out windows will also
  // register here in Phase 1; entries are dropped on webContents destroy.
  const mainWebContentsId = mainWindow.webContents.id
  registerWindow(mainWebContentsId, 'main')
  setMainWindowId(mainWebContentsId)
  // Capture the id now — reading webContents off a destroyed window throws.
  mainWindow.webContents.on('destroyed', () => {
    unregisterWindow(mainWebContentsId)
    dropEditorWindow(mainWebContentsId)
  })

  // ── Dirty-tab quit guard ──
  // Each renderer pushes its dirty-tab count whenever the set changes, keyed
  // by sender webContents id. The quit guard and isDirtyOpenPath use the SUM
  // and UNION across all windows respectively.
  ipcMain.handle('editor:dirty-state', (event, state: number | { count?: number; paths?: string[] }) => {
    const senderId = event.sender.id
    if (typeof state === 'number') {
      updateWindowDirtyState(senderId, state >= 0 ? state : 0, [])
      return
    }
    if (!state || typeof state !== 'object') {
      updateWindowDirtyState(senderId, 0, [])
      return
    }
    const count = typeof state.count === 'number' && state.count >= 0 ? state.count : 0
    const paths = Array.isArray(state.paths)
      ? state.paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : []
    updateWindowDirtyState(senderId, count, paths)
  })

  // ── Editor tab snapshot ──
  // Each renderer pushes open tabs + active document whenever they change,
  // keyed by sender webContents id. The editor.state tool merges all windows.
  ipcMain.handle('editor:state', (event, state: unknown) => {
    updateWindowEditorState(event.sender.id, state)
  })

  // Track which window was most recently focused so editor.state can pick
  // the right activeDocument.
  app.on('browser-window-focus', (_event, win) => {
    noteWindowFocused(win.webContents.id)
  })

  // ── Pop-out window IPC ──

  ipcMain.handle('popout:open-with-tab', async (_event, tab: unknown) => {
    try {
      const popout = createPopoutWindow()
      const popoutId = popout.webContents.id

      popout.webContents.setWindowOpenHandler(({ url }) => {
        if (shouldOpenExternal(url)) shell.openExternal(url)
        return { action: 'deny' }
      })

      // Register in the window registry and track
      registerWindow(popoutId, 'popout')
      popoutWindows.set(popoutId, popout)

      // Capture id before destroyed callback
      popout.webContents.on('destroyed', () => {
        unregisterWindow(popoutId)
        dropEditorWindow(popoutId)
        popoutWindows.delete(popoutId)
      })

      // Per-popout close guard
      popout.on('close', (e) => {
        const dirtyState = getWindowDirtyState(popoutId)
        const guard = popoutCloseGuardMessage(dirtyState?.count ?? 0)
        if (guard.shouldPrompt && !popout.isDestroyed()) {
          const choice = dialog.showMessageBoxSync(popout, {
            type: 'warning',
            buttons: ['Close', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Unsaved changes',
            message: guard.message,
          })
          if (choice === 1) {
            e.preventDefault()
          }
        }
      })

      // Focus main window when popout closes
      popout.on('closed', () => {
        removeReadyResolver(popoutId)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.focus()
        }
      })

      // Load the popout renderer
      if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        popout.loadURL(`${process.env.ELECTRON_RENDERER_URL}/popout.html`)
      } else {
        popout.loadFile(join(__dirname, '../renderer/popout.html'))
      }

      // Wait for the popout shell to signal readiness (or timeout)
      const ready = await new Promise<boolean>((resolve) => {
        addReadyResolver(popoutId, resolve)
      })

      if (!ready) {
        if (!popout.isDestroyed()) popout.destroy()
        return { ok: false }
      }

      // Deliver the tab to the popout, then show the window
      popout.webContents.send('editor:adopt-tab', tab)
      if (!popout.isDestroyed()) popout.show()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('popout:return-tab', async (_event, tab: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
    mainWindow.webContents.send('editor:adopt-tab', tab)
    return { ok: true }
  })

  ipcMain.handle('popout:ready', (event) => {
    resolveReady(event.sender.id)
  })

  ipcMain.handle('popout:set-edited', (event, state: unknown) => {
    const payload = normalizeSetEditedPayload(state)
    if (!payload) return
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!senderWindow || senderWindow.isDestroyed()) return
    try {
      if (payload.title) senderWindow.setTitle(payload.title)
      if (process.platform === 'darwin') {
        senderWindow.setDocumentEdited(payload.dirty)
      }
      if (payload.path) {
        const ws = tools.getWorkspacePath()
        if (ws && process.platform === 'darwin') {
          senderWindow.setRepresentedFilename(join(ws, payload.path))
        }
      } else if (process.platform === 'darwin') {
        senderWindow.setRepresentedFilename('')
      }
    } catch {
      // Best-effort; tolerate Electron API failures
    }
  })

  ipcMain.handle('popout:forward', async (_event, command: unknown) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) return { ok: false }
    const cmd = command as Record<string, unknown>
    if (typeof cmd.type !== 'string') return { ok: false }
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }

    if (cmd.type === 'terminal.send') {
      mainWindow.webContents.send('popout:main-command', { type: 'terminal.send', payload: cmd.payload })
      return { ok: true }
    }
    if (cmd.type === 'chat.prepareDraft') {
      mainWindow.webContents.send('popout:main-command', { type: 'chat.prepareDraft', payload: cmd.payload })
      mainWindow.show()
      mainWindow.focus()
      return { ok: true }
    }
    return { ok: false }
  })

  // ── Main window close: macOS hide or real app quit ──

  confirmAppQuit = () => {
    const decision = closeGuardDecision(totalDirtyCount(), packageJobs.activeRunCount(), agentSessions.activeSessionCount())
    if (!decision.shouldPrompt || !mainWindow || mainWindow.isDestroyed()) return true

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: decision.message,
    })
    return choice !== 1
  }

  mainWindow.on('close', (e) => {
    if (mainWindowCloseAction(process.platform, isQuitting) === 'hide') {
      e.preventDefault()
      mainWindow?.hide()
      return
    }

    if (!isQuitting && confirmAppQuit && !confirmAppQuit()) {
      e.preventDefault()
      return
    }

    if (!quitSyncComplete && backgroundSync) {
      e.preventDefault()
      finishBackgroundSyncThenQuit()
      return
    }

    // Closing the main window is the quit path on Windows/Linux. Mark it now
    // so window-all-closed -> app.quit() does not show the guard a second time.
    isQuitting = true
    // Close all popouts when the main window closes
    closeAllPopouts()
  })

  rebuildApplicationMenu()

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function readApprovalMode(): ApprovalMode {
  return readPersonalApprovalMode()
}

app.setName('Mim')
configureLinuxCommandLine(app.commandLine)

app.on('activate', () => {
  restoreMainWindow(mainWindow)
})

app.whenReady().then(() => {
  // Dev dock icon (packaged builds get the icon from electron-builder config).
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = join(__dirname, '../../resources/icon.png')
    if (existsSync(iconPath)) app.dock.setIcon(nativeImage.createFromPath(iconPath))
  }
  return boot()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  if (confirmAppQuit && !confirmAppQuit()) {
    event.preventDefault()
    return
  }
  if (!quitSyncComplete && backgroundSync) {
    event.preventDefault()
    finishBackgroundSyncThenQuit()
    return
  }
  isQuitting = true
})

app.on('will-quit', () => {
  clearAppUpdateTimers()
  if (teamUpdateInterval != null) {
    clearInterval(teamUpdateInterval)
    teamUpdateInterval = null
  }
  if (routineTickerInterval != null) {
    clearInterval(routineTickerInterval)
    routineTickerInterval = null
  }
  void routineAutomationStop?.()
  routineAutomationStop = null
  packageJobsStop?.()
  packageJobsStop = null
  agentSessionsStop?.()
  agentSessionsStop = null
  if (historyBaselineTimer != null) {
    clearTimeout(historyBaselineTimer)
    historyBaselineTimer = null
  }
  void telemetryShutdown?.()
  telemetryShutdown = null
  void subagentShutdown?.()
  subagentShutdown = null
  void workspaceFileWatcher?.close()
  workspaceFileWatcher = null
  backgroundSync?.stop()
  backgroundSync = null
  desktopServerClose?.()
  desktopServerClose = null
  if (ownedMcpDiscovery) {
    deleteMcpDiscoveryFile(HOME_DIR, ownedMcpDiscovery)
    ownedMcpDiscovery = null
  }
  closeSearchDb()
  confirmAppQuit = null
})

app.on('window-all-closed', () => {
  if (shouldQuitWhenAllWindowsClose(process.platform)) app.quit()
})
