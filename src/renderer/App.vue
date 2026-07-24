<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from 'vue'
import { IconHelpCircle, IconMessageCirclePlus } from '@tabler/icons-vue'
import ShellSidebar from './components/sidebar/ShellSidebar.vue'
import WorkbenchShell from './components/workbench/WorkbenchShell.vue'
import NavigatorPane from './components/workbench/NavigatorPane.vue'
import WorkPane from './components/workbench/WorkPane.vue'
import ArtifactPane from './components/workbench/ArtifactPane.vue'
import WorkHost from './components/workbench/WorkHost.vue'
import ArtifactHost from './components/workbench/ArtifactHost.vue'
import PaneHeader from './components/workbench/PaneHeader.vue'
import PaneRecoveryState from './components/workbench/PaneRecoveryState.vue'
import SettingsDialog from './components/settings/SettingsDialog.vue'
import { DEFAULT_SETTINGS_SECTION, type SettingsSection } from './components/settings/sections.js'
import InitWorkspaceBanner from './components/InitWorkspaceBanner.vue'
import AddProjectDialog from './components/AddProjectDialog.vue'
import ToastHost from './components/ToastHost.vue'
import WelcomeDialog from './components/WelcomeDialog.vue'
import ShortcutsDialog from './components/ShortcutsDialog.vue'
import CommandPalette from './components/CommandPalette.vue'
import type { WorkspaceMoveResult } from './components/files/fileMove.js'
import { routeKeyEvent, type KeyContext } from './services/workbench/keyRouter.js'
import { shortcutLabel } from './services/shortcutLabels.js'
import { decideLanding } from './services/workbench/landingDecision.js'
import { useWorkspaceFileIndex } from './services/workspaceFileIndex.js'
import { useSessionStore } from './stores/sessions.js'
import { useSettingsStore } from './stores/settings.js'
import { useAppsStore } from './stores/coreApps.js'
import { useApprovalsStore, type ApprovalRequest } from './stores/approvals.js'
import { useDiffStore } from './stores/diff.js'
import { useToastStore } from './stores/toasts.js'
import { approvalDiffNotice, buildApprovalDiff } from './services/approvalDiff.js'
import {
  useWorkbenchStore,
  type ArtifactEntry,
  type ArtifactReplacementDecision,
  type WorkEntry,
} from './stores/workbench.js'
import {
  useRunsStore,
  type AgentSessionRuntime,
  type PackageRunRecord,
} from './stores/runs.js'
import { useAgentsStore } from './stores/agents.js'
import { useAppAgentsStore } from './stores/appAgents.js'
import {
  routeWorkbenchCommand,
  type WorkbenchCommand,
} from './services/workbench/commands.js'
import { resolveArtifactHostId, resolveWorkHost } from './services/workbench/hosts.js'
import {
  editorArtifactEntry,
  NAVIGATOR_HEADER_BRIDGE_INSET,
  NAVIGATOR_SPINE_WIDTH,
} from './services/workbench/entries.js'
import type { LoadedPackage } from './services/appShell/types.js'
import {
  artifactRailMeta as resolveArtifactRailMeta,
  artifactSubtitle as resolveArtifactSubtitle,
  artifactTitle as resolveArtifactTitle,
  recentWorkspaceMenuItems,
  workRailMeta as resolveWorkRailMeta,
  workSubtitle as resolveWorkSubtitle,
  workTitle as resolveWorkTitle,
  workspaceLabel,
} from './services/appShell/labels.js'
import {
  isAgentSessionEventPayload,
  isPackageJobEventPayload,
  isPackageRunBridgePayload,
  isPackageViewBridgePayload,
} from './services/appShell/payloads.js'
import {
  resolveNavigatorSurfaceAction,
  resolvePackageOpenAction,
  resolvePaletteAction,
} from './services/appShell/routing.js'
import { createDocumentActions } from './services/appShell/documentActions.js'
import { createRunActions } from './services/appShell/runActions.js'
import { createWorkbenchActions } from './services/appShell/workbenchActions.js'
import { registerAppKernelEvents } from './services/appShell/kernelEvents.js'
import { runKeyAction } from './services/appShell/keyboardActions.js'
import { sortWithManualOrder } from './components/sidebar/sidebarOrdering.js'
import { runShellAction as executeShellAction } from './services/appShell/shellActions.js'
import { handleCloseTab as executeCloseTabAction } from './services/appShell/closeTabActions.js'
import {
  ARTIFACT_MIN_WIDTH,
  artifactFrameStyle as resolveArtifactFrameStyle,
  availableArtifactPanelMaxWidth,
  clampPanelWidth,
  createPaneResizeActions,
} from './services/appShell/paneSizing.js'
import { createWorkSurfaceActions } from './services/appShell/workSurfaceActions.js'
import {
  createWorkspaceActions,
  workspaceDisplayName,
  type WorkspaceStatus,
} from './services/appShell/workspaceActions.js'
import { createAppLifecycleActions } from './services/appShell/appLifecycle.js'

const packages = ref<LoadedPackage[]>([])
const port = ref<number>(0)
const workspace = ref<string | null>(null)
const workspaceStatus = ref<WorkspaceStatus | null>(null)
const workspaceAuthoritativeName = ref<string | null>(null)

const sessionStore = useSessionStore()
const settingsStore = useSettingsStore()
const workbenchStore = useWorkbenchStore()
const runsStore = useRunsStore()
const agentsStore = useAgentsStore()
const appAgentsStore = useAppAgentsStore()
const appsStore = useAppsStore()
const approvalsStore = useApprovalsStore()
const diffStore = useDiffStore()
const toastStore = useToastStore()
const workHostRef = ref<{
  sendExternalMessage?: (message: string) => Promise<void> | void
  prepareChatDraft?: (payload: { text?: string; attachments?: unknown[]; contextChips?: unknown[] }) => Promise<void> | void
  runTerminalCommand?: (command: string) => Promise<void> | void
  sendTerminalText?: (text: string, opts?: { spawn?: { program: string } }) => Promise<void> | void
  addTerminalTab?: () => Promise<void> | void
  closeTerminalTab?: () => void
} | null>(null)
const artifactHostRef = ref<{
  openFile?: (path: string) => void
  openDocument?: (path: string, kind: 'text' | 'pdf' | 'card' | 'table') => Promise<void> | void
  openReadOnlyTab?: (name: string, content: string, sourceId: string) => Promise<void> | void
  openHistoryForPath?: (path: string) => void
  retargetDocumentPath?: (oldPath: string, newPath: string, type: WorkspaceMoveResult['type']) => void
  newUntitledTab?: () => void
  closeActiveTab?: () => void
  cycleTab?: (direction: 1 | -1) => void
  saveActiveFile?: () => Promise<boolean> | boolean
  saveActiveFileAs?: () => Promise<boolean> | boolean
  openExportDialog?: () => void
  getArtifactReplacementDecision?: (
    current: ArtifactEntry,
    next: ArtifactEntry | null,
  ) => ArtifactReplacementDecision
  adoptTab?: (tab: unknown) => void
  popOutActiveTab?: () => Promise<void> | void
  hasActiveEditorTab?: () => boolean
} | null>(null)
const settingsOpen = ref(false)
const settingsSection = ref<SettingsSection>(DEFAULT_SETTINGS_SECTION)
const addProjectOpen = ref(false)
const addProjectMode = ref<'new' | 'clone'>('new')
const welcomeOpen = ref(false)
const shortcutsOpen = ref(false)
const paletteOpen = ref(false)
// Snapshot of whether an editor tab is active, taken when the palette opens —
// gates editor-scoped palette actions (Move Tab to New Window).
const paletteEditorTabActive = ref(false)
const fileIndex = useWorkspaceFileIndex()
const sidebarDragging = ref(false)
const rightDragging = ref(false)
const filesRefreshKey = ref(0)
const archiveRefreshKey = ref(0)
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 0)
let packageRunsRefreshTimer: number | null = null
let unregisterKernelEvents: (() => void) | null = null
const WELCOME_KEY = 'mim:welcomeDismissed'

const activeWork = computed(() => workbenchStore.activeWork)
const activeWorkHost = computed(() => resolveWorkHost(activeWork.value))
const activeWorkId = computed(() => activeWork.value?.id ?? '')
const activeWorkPackageId = computed(() =>
  activeWork.value?.kind === 'package-view' ? activeWork.value.packageId : ''
)
const activeWorkPackage = computed(() =>
  activeWorkPackageId.value
    ? packages.value.find(pkg => pkg.manifest.id === activeWorkPackageId.value) ?? null
    : null
)
const activeWorkPackageHasReadme = computed(() => activeWorkPackage.value?.hasReadme === true)
const activeArtifact = computed(() => workbenchStore.activeArtifact)
const activeArtifactHostId = computed(() => resolveArtifactHostId(activeArtifact.value))
const activeFilePath = ref('')
const workCanBack = computed(() => workbenchStore.workHistory.backStack.length > 0)
const workCanForward = computed(() => workbenchStore.workHistory.forwardStack.length > 0)
const artifactCanBack = computed(() => workbenchStore.artifactHistory.backStack.length > 0)
const artifactCanForward = computed(() => workbenchStore.artifactHistory.forwardStack.length > 0)
const workNavigationError = computed(() => workbenchStore.navigationErrors.work)
const artifactNavigationError = computed(() => workbenchStore.navigationErrors.artifact)
const workPaneState = computed(() => workbenchStore.paneLayout.work.state)
const artifactPaneState = computed(() => workbenchStore.paneLayout.artifact.state)
const sidebarOpen = computed({
  get: () => workbenchStore.navigatorVisible,
  set: visible => workbenchStore.setPaneVisibility('navigator', visible),
})
const sidebarWidth = computed({
  get: () => workbenchStore.paneLayout.navigator.width,
  set: width => workbenchStore.setPaneWidth('navigator', width),
})
const rightVisible = computed({
  get: () => workbenchStore.artifactVisible,
  set: visible => workbenchStore.setPaneVisibility('artifact', visible),
})
const rightPanelWidth = computed({
  get: () => workbenchStore.paneLayout.artifact.width,
  set: width => workbenchStore.setPaneWidth('artifact', width),
})
const rightExpanded = computed({
  get: () => workbenchStore.artifactExpanded,
  set: expanded => workbenchStore.setArtifactExpanded(expanded),
})
const workExpanded = computed({
  get: () => workbenchStore.workExpanded,
  set: expanded => workbenchStore.setWorkExpanded(expanded),
})
const navigatorCollapsed = computed(() => !sidebarOpen.value)
const showNavigatorRestoreInWorkHeader = computed(() =>
  navigatorCollapsed.value && workPaneState.value === 'expanded'
)
const showNavigatorRestoreInArtifactHeader = computed(() =>
  navigatorCollapsed.value && workPaneState.value !== 'expanded' && artifactPaneState.value === 'expanded'
)
// Collapsed Navigator: the Work header bridges into the rail chrome, so its
// leading controls shift past the traffic lights. Artifact headers start at
// x>=96 and clear the lights without an inset.
const workHeaderBridgeInset = computed(() =>
  showNavigatorRestoreInWorkHeader.value ? NAVIGATOR_HEADER_BRIDGE_INSET : 0
)
const workPaneLeftConnected = computed(() => navigatorCollapsed.value)
const availableRightPanelMaxWidth = computed(() =>
  availableArtifactPanelMaxWidth({
    viewportWidth: viewportWidth.value,
    navigatorVisible: sidebarOpen.value,
    navigatorWidth: sidebarWidth.value,
    navigatorSpineWidth: NAVIGATOR_SPINE_WIDTH,
    workPaneState: workPaneState.value,
  })
)
const clampedRightPanelWidth = computed(() =>
  clampPanelWidth(rightPanelWidth.value, {
    min: ARTIFACT_MIN_WIDTH,
    max: availableRightPanelMaxWidth.value,
  })
)
const artifactFrameStyle = computed(() =>
  resolveArtifactFrameStyle({
    expanded: rightExpanded.value,
    width: clampedRightPanelWidth.value,
  })
)
const paneResizeActions = createPaneResizeActions({
  document,
  getSidebarWidth: () => sidebarWidth.value,
  setSidebarWidth: width => { sidebarWidth.value = width },
  setSidebarDragging: dragging => { sidebarDragging.value = dragging },
  persistSidebarWidth: width => { settingsStore.set('sidebarWidth', width) },
  getArtifactWidth: () => rightPanelWidth.value,
  getArtifactMaxWidth: () => availableRightPanelMaxWidth.value,
  setArtifactWidth: width => { rightPanelWidth.value = width },
  setArtifactDragging: dragging => { rightDragging.value = dragging },
  persistArtifactWidth: width => { settingsStore.set('rightPanelWidth', width) },
})
const onSidebarResize = paneResizeActions.onSidebarResize
const onRightResize = paneResizeActions.onArtifactResize
const workspaceActions = createWorkspaceActions({
  workspacePath: () => workspace.value,
  setWorkspaceStatus: status => { workspaceStatus.value = status },
  setWorkspaceAuthoritativeName: name => { workspaceAuthoritativeName.value = name },
  callKernel: (tool, params) =>
    params === undefined ? window.kernel.call(tool) : window.kernel.call(tool, params),
  openWorkspaceDialog: () => window.kernel.openWorkspace(),
  openWorkspacePathInKernel: path => window.kernel.openWorkspacePath(path),
  addRecentWorkspace: path => { settingsStore.addRecentWorkspace(path) },
  removeRecentWorkspace: path => { settingsStore.removeRecentWorkspace(path) },
  pushToast: toast => { toastStore.push(toast) },
})
const refreshWorkspaceStatus = workspaceActions.refreshWorkspaceStatus
const initializeWorkspace = workspaceActions.initializeWorkspace
const openWorkspace = workspaceActions.openWorkspace
const openWorkspacePath = workspaceActions.openWorkspacePath

// ---- Header rename ----
const renaming = ref(false)
const renameValue = ref('')

function startRename() {
  const s = sessionStore.activeSession
  if (!s) return
  renameValue.value = s.label
  renaming.value = true
}

function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  const s = sessionStore.activeSession
  if (!s) return
  const trimmed = renameValue.value.trim()
  if (trimmed && trimmed !== s.label) {
    sessionStore.rename(s.id, trimmed)
  }
}

function cancelRename() {
  renaming.value = false
}

// ---- Computed ----

const workspaceName = computed(() =>
  workspaceDisplayName({
    authoritativeName: workspaceAuthoritativeName.value,
    path: workspace.value,
  })
)

const workspacePath = computed(() => workspace.value ?? null)

const recentWorkspacesForMenu = computed(() =>
  recentWorkspaceMenuItems(settingsStore.recentWorkspaces, workspace.value)
)

const sessionLabel = computed(() =>
  sessionStore.activeSession?.label ?? null
)

const workLabel = computed(() => {
  return resolveWorkTitle(
    activeWork.value,
    sessionLabel.value,
    runsStore.packageRuns,
    runsStore.agentSessions,
  )
})

const workSubtitle = computed(() => resolveWorkSubtitle(activeWork.value))

const artifactLabel = computed(() => resolveArtifactTitle(activeArtifact.value))

const artifactSubtitle = computed(() => resolveArtifactSubtitle(activeArtifact.value))

const workRailMeta = computed(() => resolveWorkRailMeta(activeWork.value))

const artifactRailMeta = computed(() => resolveArtifactRailMeta(activeArtifact.value))

const canRenameWork = computed(() =>
  activeWork.value?.kind === 'chat' && !!sessionStore.activeSession
)

// ---- Window title ----
watch(workLabel, (label) => {
  if (label) {
    document.title = `${label} — Mim`
  } else {
    document.title = 'Mim'
  }
}, { immediate: true })

// ---- Keep the native "Open Recent" menu in sync with persisted recents ----
watch(() => settingsStore.recentFiles, (list) => {
  window.kernel.setRecentFiles?.(Array.isArray(list) ? [...list] : [])
}, { deep: true, immediate: true })

function updateViewportWidth() {
  viewportWidth.value = window.innerWidth
}

// ---- Actions ----

// Restoring an archived conversation drops you back into the Work stage on it.
function onArchiveOpenSession(id: string) {
  void openChatWork(id)
}

// ---- Workbench command adapter ----

async function restoreWorkbenchSettingsFromSettings() {
  if (settingsStore.sidebarWidth) {
    workbenchStore.setPaneWidth('navigator', settingsStore.sidebarWidth)
  }
  if (settingsStore.rightPanelWidth) {
    workbenchStore.setPaneWidth('artifact', settingsStore.rightPanelWidth)
  }
}

const workSurfaceActions = createWorkSurfaceActions({
  activeSessionId: () => sessionStore.activeSessionId,
  sessionLabel: sessionId => sessionStore.sessions.find(session => session.id === sessionId)?.label,
  packages: () => packages.value,
  openWorkEntry,
  incrementFilesRefresh: () => { filesRefreshKey.value += 1 },
  incrementArchiveRefresh: () => { archiveRefreshKey.value += 1 },
  visibleSessions: () => sessionStore.visibleSessions,
})
const openDraftChatWork = workSurfaceActions.openDraftChatWork
const openAgentChatOrDraft = workSurfaceActions.openAgentChatOrDraft
const openChatWork = workSurfaceActions.openChatWork
const openRoutinesWork = workSurfaceActions.openRoutinesWork
const openTerminalWork = workSurfaceActions.openTerminalWork
const openFilesWork = workSurfaceActions.openFilesWork
const openActivityTrustWork = workSurfaceActions.openActivityTrustWork
const openFallbackWork = workSurfaceActions.openFallbackWork
const openFilesWorkPreservingArtifact = workSurfaceActions.openFilesWorkPreservingArtifact
const openArchiveWork = workSurfaceActions.openArchiveWork
const openPackageViewWork = workSurfaceActions.openPackageViewWork

const runActions = createRunActions({
  activeWork: () => activeWork.value,
  packageRuns: () => runsStore.packageRuns,
  agentSessions: () => runsStore.agentSessions,
  getAgentExtraArgs: agentId => agentsStore.getExtraArgs(agentId),
  callKernel: (tool, params) => window.kernel.call(tool, params),
  openWorkEntry,
  openFallbackWork,
  openFilesWorkPreservingArtifact,
  openNextActivity,
  removeWorkHistoryEntry: entryId => workbenchStore.removePaneHistoryEntry('work', entryId),
  setWorkNavigationError: err => workbenchStore.setNavigationError('work', err),
  upsertPackageRun: run => runsStore.upsertPackageRun(run),
  removePackageRun: runId => runsStore.removePackageRun(runId),
  applyAgentSessionEvent: event => runsStore.applyAgentSessionEvent(event),
  removeAgentSession: sessionId => runsStore.removeAgentSession(sessionId),
  archiveChatSession: sessionId => sessionStore.archive(sessionId),
  deleteChatSession: sessionId => sessionStore.remove(sessionId),
  incrementArchiveRefresh: () => { archiveRefreshKey.value += 1 },
  refreshPackageRuns: () => refreshPackageRuns(),
})

async function openPackageRunWork(packageId: string, runId: string) {
  await runActions.openPackageRunWork(packageId, runId)
}

async function archivePackageRun(packageId: string, runId: string) {
  await runActions.archivePackageRun(packageId, runId)
}

async function deletePackageRun(packageId: string, runId: string) {
  await runActions.deletePackageRun(packageId, runId)
}

async function selectPackageAgent(agentId: string) {
  const mount = appAgentsStore.byId(agentId)
  const name = mount?.name ?? agentId
  await openAgentChatOrDraft(agentId, name)
}

async function launchAgentSession(agentId: string) {
  await runActions.launchAgentSession(agentId)
}

async function openAgentSessionWork(agentId: string, sessionId: string) {
  await runActions.openAgentSessionWork(agentId, sessionId)
}

async function stopAgentSession(sessionId: string) {
  await runActions.stopAgentSession(sessionId)
}

async function stopSubagentSession(sessionId: string) {
  await window.kernel.call('subagent.stop', { sessionId })
  await sessionStore.refresh(sessionId)
}

async function archiveAgentSession(sessionId: string) {
  await runActions.archiveAgentSession(sessionId)
}

async function deleteAgentSession(sessionId: string) {
  await runActions.deleteAgentSession(sessionId)
}

async function archiveSession(sessionId: string) {
  await runActions.archiveSession(sessionId)
}

async function deleteSession(sessionId: string) {
  await runActions.deleteSession(sessionId)
}

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
  removeFailedWorkBackingEntry: async entry => {
    if (entry.kind !== 'agent-session') return false
    await runActions.deleteAgentSession(entry.sessionId)
    return true
  },
  setPaneState: (pane, state) => workbenchStore.setPaneState(pane, state),
  setPaneVisibility: (pane, visible) => workbenchStore.setPaneVisibility(pane, visible),
  setNavigationError: (pane, error) => workbenchStore.setNavigationError(pane, error),
  confirmArtifactReplacement: () => window.confirm('The current Artifact has unsaved changes. Continue anyway?'),
  nextTick: () => nextTick(),
  openFileInArtifactHost: path => { artifactHostRef.value?.openFile?.(path) },
})

async function openWorkEntry(entry: WorkEntry, options?: Parameters<typeof workbenchActions.openWorkEntry>[1]) {
  return workbenchActions.openWorkEntry(entry, options)
}

async function openArtifactEntry(entry: ArtifactEntry, options?: Parameters<typeof workbenchActions.openArtifactEntry>[1]) {
  return workbenchActions.openArtifactEntry(entry, options)
}

async function recordMountedArtifactActivation(entry: ArtifactEntry) {
  await workbenchActions.recordMountedArtifactActivation(entry)
}

function handleActiveFileChanged(path: string) {
  activeFilePath.value = path
}

async function dispatchWorkbenchCommand(command: WorkbenchCommand) {
  try {
    await routeWorkbenchCommand(command, {
      openWork: openWorkEntry,
      openArtifact: openArtifactEntry,
      runTerminal: runTerminalCommand,
      sendTerminal: sendTerminalText,
      sendChat: sendChatMessage,
    })
  } catch (err) {
    workbenchStore.setNavigationError(
      command.type === 'editor.open' ? 'artifact' : 'work',
      err,
    )
    console.error('[workbench]', command.type, err)
  }
}

function clearNavigationError(pane: 'work' | 'artifact') {
  workbenchActions.clearNavigationError(pane)
}

async function retryWorkRecovery() {
  await workbenchActions.retryWorkRecovery()
}

async function retryArtifactRecovery() {
  await workbenchActions.retryArtifactRecovery()
}

async function removeFailedWorkEntry() {
  await workbenchActions.removeFailedWorkEntry()
}

async function removeFailedArtifactEntry() {
  await workbenchActions.removeFailedArtifactEntry()
}

async function navigateWorkHistory(direction: 'back' | 'forward') {
  await workbenchActions.navigateWorkHistory(direction)
}

async function navigateArtifactHistory(direction: 'back' | 'forward') {
  await workbenchActions.navigateArtifactHistory(direction)
}

function installArtifactReplacementGuard() {
  workbenchStore.setArtifactReplacementGuard(artifactReplacementDecision)
}

function artifactReplacementDecision(
  current: ArtifactEntry,
  next: ArtifactEntry | null,
): ArtifactReplacementDecision {
  return artifactHostRef.value?.getArtifactReplacementDecision?.(current, next) ?? 'yes'
}

function restoreWorkPane() {
  workbenchStore.setPaneState('work', 'expanded')
}

function restoreNavigatorPane() {
  sidebarOpen.value = true
}

function restoreArtifactPane() {
  workbenchStore.setPaneState('artifact', 'expanded')
}

function collapseWorkPane() {
  workbenchStore.setPaneState('work', 'rail')
}

function collapseArtifactPane() {
  workbenchStore.setPaneState('artifact', 'rail')
}

function toggleWorkExpanded() {
  workbenchStore.setWorkExpanded(!workExpanded.value)
}

function toggleArtifactExpanded() {
  workbenchStore.setArtifactExpanded(!rightExpanded.value)
}

async function runTerminalCommand(command: string) {
  await nextTick()
  await workHostRef.value?.runTerminalCommand?.(command)
}

async function sendTerminalText(text: string, opts?: { spawn?: { program: string } }) {
  await nextTick()
  await workHostRef.value?.sendTerminalText?.(text, opts)
}

function handleSendToTerminal(payload: { text: string; language: string | null }) {
  dispatchWorkbenchCommand({ type: 'terminal.send', text: payload.text, language: payload.language })
}

async function sendChatMessage(payload: { sessionId: string; message: string }) {
  if (sessionStore.activeSessionId !== payload.sessionId) {
    await sessionStore.select(payload.sessionId)
  }
  await nextTick()
  await workHostRef.value?.sendExternalMessage?.(payload.message)
}

async function prepareChatDraft(payload: {
  targetSessionId?: string | null
  text: string
  attachments: unknown[]
  contextChips?: unknown[]
}) {
  if (payload.targetSessionId) {
    await openChatWork(payload.targetSessionId)
  } else {
    await openDraftChatWork()
  }
  await nextTick()
  await workHostRef.value?.prepareChatDraft?.({
    text: payload.text,
    attachments: payload.attachments,
    contextChips: payload.contextChips ?? [],
  })
}

async function routeBridgeChatSend(data: unknown) {
  const { message, sessionId: requestedSessionId } = data as {
    message?: unknown
    sessionId?: unknown
  }
  if (typeof message !== 'string' || message.length === 0) return

  let sessionId = typeof requestedSessionId === 'string' && requestedSessionId.length > 0
    ? requestedSessionId
    : sessionStore.activeSessionId

  if (!sessionId) {
    const session = await sessionStore.create()
    sessionId = session.id
  }

  await dispatchWorkbenchCommand({ type: 'chat.send', sessionId, message })
}

async function routeBridgeWorkbenchOpenWork(data: unknown) {
  if (isPackageRunBridgePayload(data)) {
    await openPackageRunWork(data.packageId, data.runId)
    return
  }
  if (isPackageViewBridgePayload(data)) {
    await openPackageViewWork(data.packageId, data.viewId)
  }
}

async function routeBridgeWorkbenchOpenArtifact(data: unknown) {
  void data
}

// ---- Editor file actions (native menu + keyboard) ----

const documentActions = createDocumentActions({
  activeArtifactHostId: () => activeArtifactHostId.value,
  rightVisible: () => rightVisible.value,
  artifactHost: () => artifactHostRef.value,
  openEditorFileArtifact: path => dispatchWorkbenchCommand({ type: 'editor.open', path }),
  openArtifactEntry,
  setArtifactVisible: visible => workbenchStore.setPaneVisibility('artifact', visible),
  railArtifactPane: () => workbenchStore.setPaneState('artifact', 'rail'),
  readFileHead,
  openNativeFile: path => window.kernel.openNativeFile(path),
  openFileDialog: () => window.kernel.openFileDialog(),
  addRecentFile: path => settingsStore.addRecentFile(path),
  setArtifactNavigationError: err => workbenchStore.setNavigationError('artifact', err),
  nextTick: () => nextTick(),
  trackTelemetry,
})

async function openFileInEditor(path: string) {
  await documentActions.openFileInEditor(path)
}

async function openFileHistory(path: string) {
  await documentActions.openFileHistory(path)
}

async function readFileHead(path: string): Promise<string> {
  const result = await window.kernel.call('fs.read', { path, max_chars: 4000 }) as { content?: string }
  return result.content ?? ''
}

function trackTelemetry(event: string, props: Record<string, unknown> = {}): void {
  try {
    void window.kernel.call('telemetry.track', { event, props }).catch(() => {})
  } catch {
    // Telemetry is best-effort and must never affect navigation.
  }
}

async function openFileInNativeApp(path: string) {
  await documentActions.openFileInNativeApp(path)
}

async function openFileViaDialog() {
  await documentActions.openFileViaDialog()
}

function handleFilePathMoved(move: WorkspaceMoveResult) {
  artifactHostRef.value?.retargetDocumentPath?.(move.oldPath, move.newPath, move.type)
}

async function createUntitledInEditor() {
  await documentActions.createUntitledInEditor()
}

async function openPackageDocs(id: string) {
  if (!id) return
  try {
    const docs = await window.kernel.call('package.readme', { id }) as {
      id: string
      name: string
      content: string
    }
    const opened = await documentActions.ensureDocumentHostVisible()
    if (!opened) return
    await nextTick()
    await artifactHostRef.value?.openReadOnlyTab?.(
      `${docs.name} README.md`,
      docs.content,
      `package:${docs.id}:readme`,
    )
  } catch (err) {
    workbenchStore.setNavigationError('artifact', err)
    console.error('[apps] open README', err)
  }
}

const shellActionDeps = {
  openDraftChatWork,
  openRoutinesWork,
  openFilesWork,
  openActivityTrustWork,
  openTerminalWork,
  openArchiveWork,
  openPackageViewWork,
  openSettings,
  createUntitledInEditor,
  openFileViaDialog,
  openExportDialog: () => { artifactHostRef.value?.openExportDialog?.() },
  popOutActiveTab: () => { artifactHostRef.value?.popOutActiveTab?.() },
  openShortcuts: () => { shortcutsOpen.value = true },
  openChatWork,
  openFileInEditor,
}

async function runShellAction(action: Parameters<typeof executeShellAction>[0]) {
  await executeShellAction(action, shellActionDeps)
}

async function selectNavigatorWorkSurface(id: string) {
  await runShellAction(resolveNavigatorSurfaceAction(id, packages.value))
}

async function openPackageFromWork(id: string) {
  await runShellAction(resolvePackageOpenAction(id, packages.value))
}

function openSettings(section: SettingsSection = DEFAULT_SETTINGS_SECTION) {
  settingsSection.value = section
  settingsOpen.value = true
}

// First-run orientation: each welcome row routes to its surface and dismisses.
async function handleWelcomeAction(action: 'chat' | 'file' | 'terminal' | 'apps') {
  welcomeOpen.value = false
  if (action === 'chat') await selectNavigatorWorkSurface('__chat__')
  else if (action === 'file') await openFileViaDialog()
  else if (action === 'terminal') await selectNavigatorWorkSurface('__terminal__')
  else if (action === 'apps') openSettings('apps')
}

async function openPackageFromSettings(id: string) {
  settingsOpen.value = false
  await openPackageFromWork(id)
}

async function openPackageDocsFromSettings(id: string) {
  settingsOpen.value = false
  await openPackageDocs(id)
}

// Cmd/Ctrl+W arrives via the native File ▸ Close Tab accelerator (a menu
// accelerator, so the renderer never sees the keydown). Route it to the
// surface in focus: editor tab, then terminal tab, then archive the session.
function handleCloseTab() {
  executeCloseTabAction({
    editorPaneFocused: () => isEditorFocused() || focusedPane() === 'artifact',
    activeWorkHost: () => activeWorkHost.value,
    closeActiveArtifactTab: () => { artifactHostRef.value?.closeActiveTab?.() },
    closeTerminalTab: () => { workHostRef.value?.closeTerminalTab?.() },
    artifactVisible: () => rightVisible.value,
    hasActiveArtifactTab: () => artifactHostRef.value?.hasActiveEditorTab?.() ?? false,
    activeArtifactHostId: () => activeArtifactHostId.value,
    activeSession: () => sessionStore.activeSession,
    archiveSession: sessionId => { sessionStore.archive(sessionId) },
    activeAgentSessionId: () => activeWork.value?.kind === 'agent-session' ? activeWork.value.sessionId : null,
    archiveAgentSession: sessionId => { void archiveAgentSession(sessionId) },
    activePackageRun: () => activeWork.value?.kind === 'package-run'
      ? { packageId: activeWork.value.packageId, runId: activeWork.value.runId }
      : null,
    archivePackageRun: (packageId, runId) => { void archivePackageRun(packageId, runId) },
  })
}

function handleAllDocumentTabsClosed() {
  activeFilePath.value = ''
  documentActions.handleAllDocumentTabsClosed()
}

function handleSaveFile(forceDialog = false) {
  documentActions.handleSaveFile(forceDialog)
}

function showAddProject(mode: 'new' | 'clone') {
  addProjectMode.value = mode
  addProjectOpen.value = true
}

async function onProjectCreated(path: string) {
  await openWorkspacePath(path)
}

// ---- Command palette ----

function handlePaletteSelect(id: string) {
  void runShellAction(resolvePaletteAction(id))
}

// Open the agent's proposed change in the editor's diff view in the Artifact
// pane, beside the chat — the surface reviewing changes belongs in. The decision
// stays on the inline card; this just shows what would happen. The change has not
// run yet (the gate fires first), so this is a true before/after preview.
async function reviewApprovalChange(request: ApprovalRequest) {
  const diff = await buildApprovalDiff(request, readWorkspaceFile)
  if (!diff) return
  // The request may have been decided while the preview was being built; a
  // preview for a resolved request would show a change already applied or dropped.
  if (!approvalsStore.get(request.requestId)) return
  await openArtifactEntry(editorArtifactEntry())
  diffStore.activate({
    source: 'approval',
    original: diff.original,
    modified: diff.modified,
    path: diff.path,
    review: {
      type: 'approval',
      requestId: request.requestId,
      kind: diff.kind,
      notice: approvalDiffNotice(diff),
    },
    layout: 'unified',
  })
}

async function readWorkspaceFile(path: string): Promise<string | null> {
  try {
    const result = await window.kernel.call('fs.read', { path, full: true }) as { content?: unknown }
    return typeof result?.content === 'string' ? result.content : ''
  } catch {
    return null
  }
}

async function refreshPackageRuns() {
  try {
    const result = await window.kernel.call('package.jobs.list', { includeArchived: true }) as { runs?: PackageRunRecord[] }
    runsStore.setPackageRuns(Array.isArray(result?.runs) ? result.runs : [])
  } catch {
    runsStore.setPackageRuns([])
  }
}

function schedulePackageRunsRefresh() {
  if (packageRunsRefreshTimer != null) window.clearTimeout(packageRunsRefreshTimer)
  packageRunsRefreshTimer = window.setTimeout(() => {
    packageRunsRefreshTimer = null
    void refreshPackageRuns()
  }, 220)
}

function onPackageJobEvent(payload: unknown) {
  if (!isPackageJobEventPayload(payload)) return
  if (payload.ephemeral === true) return
  runsStore.applyPackageJobEvent(payload)
  schedulePackageRunsRefresh()
  if (payload.type === 'job.started') {
    void openPackageRunWork(payload.packageId, payload.runId)
  }
}

async function refreshAgentSessions() {
  try {
    const result = await window.kernel.call('agent.sessions.list') as { sessions?: AgentSessionRuntime[] }
    runsStore.setAgentSessions(Array.isArray(result?.sessions) ? result.sessions : [])
  } catch {
    runsStore.setAgentSessions([])
  }
}

// Agent session events carry the session identity; delete events prune rows,
// while lifecycle/change events upsert the latest record.
function onAgentSessionEvent(payload: unknown) {
  if (!isAgentSessionEventPayload(payload)) return
  runsStore.applyAgentSessionEvent(payload)
}

async function restoreInitialWork() {
  await sessionStore.load()
  if (activeWork.value) return
  const landing = decideLanding(sessionStore.activeSessionId)
  if (landing.target === 'last-session') {
    await openChatWork(landing.sessionId)
  } else {
    await openDraftChatWork()
  }
}

function isEditorFocused(): boolean {
  return !!document.activeElement?.closest('.cm-editor')
}

function isTerminalFocused(): boolean {
  return !!document.activeElement?.closest('.xterm')
}

function focusedPane(): 'work' | 'artifact' | 'none' {
  const el = document.activeElement
  if (!el) return 'none'
  if (el.closest('[data-pane="artifact"]')) return 'artifact'
  if (el.closest('[data-pane="work"]')) return 'work'
  return 'none'
}

function handleKeydown(e: KeyboardEvent) {
  const ctx: KeyContext = {
    key: e.key,
    metaOrCtrl: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    editorFocused: isEditorFocused(),
    terminalFocused: isTerminalFocused(),
    defaultPrevented: e.defaultPrevented,
    focusedPane: focusedPane(),
  }

  const result = routeKeyEvent(ctx)
  if (!result) return

  e.preventDefault()

  void runKeyAction(result, {
    openCommandPalette: () => {
      paletteEditorTabActive.value = artifactHostRef.value?.hasActiveEditorTab?.() ?? false
      paletteOpen.value = true
    },
    openDraftChatWork,
    openTerminalWork,
    addTerminalTab: () => workHostRef.value?.addTerminalTab?.(),
    toggleNavigator: () => { sidebarOpen.value = !sidebarOpen.value },
    navigateWorkHistory,
    navigateArtifactHistory,
    cycleSession,
    cycleActivity,
    cycleEditorTab: direction => { artifactHostRef.value?.cycleTab?.(direction) },
    nextTick: () => nextTick(),
  })
}

function cycleSession(direction: 1 | -1) {
  const visible = sessionStore.visibleSessions
  if (!visible.length) return
  const idx = visible.findIndex(s => s.id === sessionStore.activeSessionId)
  const next = idx === -1
    ? (direction === 1 ? 0 : visible.length - 1)
    : idx + direction
  if (next < 0 || next >= visible.length) return
  void openChatWork(visible[next].id)
}

type ActivityItem = { key: string; ts: number } & (
  | { kind: 'chat'; sessionId: string }
  | { kind: 'package-job'; packageId: string; runId: string }
  | { kind: 'agent-session'; agentId: string; sessionId: string }
)

function buildActivityList(): ActivityItem[] {
  const items: ActivityItem[] = [
    ...sessionStore.visibleSessions.map(s => ({
      key: `chat:${s.id}`,
      kind: 'chat' as const,
      sessionId: s.id,
      ts: new Date(s.updatedAt).getTime(),
    })),
    ...runsStore.packageJobRuns.map(r => ({
      key: r.id,
      kind: 'package-job' as const,
      packageId: r.packageId ?? '',
      runId: r.sourceId,
      ts: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
    })),
    ...runsStore.agentSessionRuns.map(r => ({
      key: r.id,
      kind: 'agent-session' as const,
      agentId: runsStore.agentSessions.find(a => a.sessionId === r.sourceId)?.agentId ?? '',
      sessionId: r.sourceId,
      ts: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
    })),
  ]
  items.sort((a, b) => b.ts - a.ts)
  return sortWithManualOrder(items, settingsStore.navigatorActivityOrder)
}

function activityWorkId(item: ActivityItem): string {
  if (item.kind === 'chat') return `work:chat:${item.sessionId}`
  if (item.kind === 'agent-session') return `work:agent-session:${item.sessionId}`
  return `work:package-run:${item.packageId}:${item.runId}`
}

function navigateToActivity(item: ActivityItem) {
  if (item.kind === 'chat') void openChatWork(item.sessionId)
  else if (item.kind === 'package-job') void openPackageRunWork(item.packageId, item.runId)
  else void openAgentSessionWork(item.agentId, item.sessionId)
}

function cycleActivity(direction: 1 | -1) {
  const sorted = buildActivityList()
  if (!sorted.length) return

  const workId = activeWorkId.value
  const currentIdx = sorted.findIndex(item => activityWorkId(item) === workId)
  const next = currentIdx === -1
    ? 0
    : (currentIdx + direction + sorted.length) % sorted.length

  navigateToActivity(sorted[next])
}

async function openNextActivity(closingEntryId: string) {
  const sorted = buildActivityList()
  const idx = sorted.findIndex(item => activityWorkId(item) === closingEntryId)
  const remaining = sorted.filter(item => activityWorkId(item) !== closingEntryId)
  if (remaining.length) {
    const nextIdx = idx <= 0 ? 0 : Math.min(idx, remaining.length) - 1
    navigateToActivity(remaining[nextIdx])
  } else {
    await openDraftChatWork()
  }
}

const appLifecycleActions = createAppLifecycleActions({
  loadSettings: () => settingsStore.load(),
  restoreWorkbenchSettings: restoreWorkbenchSettingsFromSettings,
  installArtifactReplacementGuard,
  getPort: () => window.kernel.getPort(),
  setPort: value => { port.value = value },
  getPackages: () => window.kernel.getPackages(),
  setPackages: pkgs => { packages.value = pkgs },
  getWorkspace: () => window.kernel.getWorkspace(),
  setWorkspacePath: path => { workspace.value = path },
  addRecentWorkspace: path => { settingsStore.addRecentWorkspace(path) },
  refreshWorkspaceStatus,
  refreshPackageRuns,
  refreshAgentSessions,
  refreshApps: () => appsStore.refresh(),
  refreshAgents: () => agentsStore.refresh(),
  refreshAppAgents: () => appAgentsStore.refresh(),
  restoreInitialWork,
  loadFileIndex: () => fileIndex.load(),
  welcomeDismissed: () => !!localStorage.getItem(WELCOME_KEY),
  markWelcomeDismissed: () => { localStorage.setItem(WELCOME_KEY, '1') },
  openWelcome: () => { welcomeOpen.value = true },
  resetWorkbenchForWorkspace: () => { workbenchStore.resetForWorkspace() },
})
const handleWorkspaceChanged = appLifecycleActions.handleWorkspaceChanged

// ---- Lifecycle ----

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', updateViewportWidth)
  updateViewportWidth()
  await appLifecycleActions.bootstrapAppShell()

  unregisterKernelEvents = registerAppKernelEvents(window.kernel, {
    setPackages: pkgs => { packages.value = pkgs },
    refreshApps: () => appsStore.refresh(),
    refreshAppAgents: () => appAgentsStore.refresh(),
    handleWorkspaceChanged,
    refreshKeyStatuses: () => settingsStore.refreshKeyStatuses(),
    enqueueApproval: request => approvalsStore.enqueue(request as ApprovalRequest),
    openFileInEditor,
    routeBridgeChatSend,
    routeBridgeWorkbenchOpenWork,
    routeBridgeWorkbenchOpenArtifact,
    openFileViaDialog,
    createUntitledInEditor,
    handleSaveFile,
    openExportDialog: () => { artifactHostRef.value?.openExportDialog?.() },
    clearRecentFiles: () => { settingsStore.clearRecentFiles() },
    handleCloseTab,
    openSettings,
    openShortcuts: () => { shortcutsOpen.value = true },
    openWelcome: () => { welcomeOpen.value = true },
    dispatchTerminalRun: (command, options) => dispatchWorkbenchCommand({ type: 'terminal.run', command, reveal: options?.reveal }),
    onPackageJobEvent,
    onAgentSessionEvent,
    refreshSubagentSession: sessionId => sessionStore.refresh(sessionId),
    pushToast: toast => { toastStore.push(toast) },
    downloadUpdate: () => window.kernel.downloadUpdate(),
    quitAndInstall: () => window.kernel.quitAndInstall(),
    adoptTab: tab => { artifactHostRef.value?.adoptTab?.(tab) },
    dispatchTerminalSend: (text, language) => handleSendToTerminal({ text, language }),
    prepareChatDraft,
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', updateViewportWidth)
  unregisterKernelEvents?.()
  unregisterKernelEvents = null
  if (packageRunsRefreshTimer != null) window.clearTimeout(packageRunsRefreshTimer)
})
</script>

<template>
  <WorkbenchShell
    :dragging="sidebarDragging || rightDragging"
  >
    <template #navigator>
      <NavigatorPane>
        <ShellSidebar
          :width="sidebarWidth"
          :collapsed="navigatorCollapsed"
          :packages="packages"
          :active-work-id="activeWorkId"
          :workspace-name="workspaceName"
          :recent-workspaces="recentWorkspacesForMenu"
          :port="port"
          @toggle="sidebarOpen = !sidebarOpen"
          @select-work="selectNavigatorWorkSurface"
          @select-session="openChatWork"
          @archive-session="archiveSession"
          @delete-session="deleteSession"
          @select-package-run="openPackageRunWork"
          @archive-package-run="archivePackageRun"
          @delete-package-run="deletePackageRun"
          @launch-agent="launchAgentSession"
          @select-package-agent="selectPackageAgent"
          @select-agent-session="openAgentSessionWork"
          @archive-agent-session="archiveAgentSession"
          @delete-agent-session="deleteAgentSession"
          @stop-agent-session="stopAgentSession"
          @stop-subagent-session="stopSubagentSession"
          @open-folder="openWorkspace"
          @open-recent-workspace="openWorkspacePath"
          @add-project="showAddProject"
          @manage-apps="openSettings('apps')"
          @settings="openSettings"
          @resize="onSidebarResize"
        />
      </NavigatorPane>
    </template>

    <template #work>
      <WorkPane
        :state="workPaneState"
        :title="workLabel ?? 'Work'"
        :subtitle="workSubtitle"
        :meta="workRailMeta"
        :left-connected="workPaneLeftConnected"
        :quiet="showNavigatorRestoreInArtifactHeader"
        @restore="restoreWorkPane"
      >
        <template #header>
          <PaneHeader
            pane="work"
            :title="workLabel ?? 'Work'"
            :subtitle="workSubtitle"
            :can-back="workCanBack"
            :can-forward="workCanForward"
            :can-collapse="true"
            :can-expand="true"
            :expanded="workExpanded"
            :renameable="canRenameWork"
            :renaming="renaming"
            :rename-value="renameValue"
            :show-navigator-restore="showNavigatorRestoreInWorkHeader"
            :bridge-inset="workHeaderBridgeInset"
            @update:rename-value="renameValue = $event"
            @back="navigateWorkHistory('back')"
            @forward="navigateWorkHistory('forward')"
            @restore-navigator="restoreNavigatorPane"
            @collapse="collapseWorkPane"
            @expand="toggleWorkExpanded"
            @start-rename="startRename"
            @commit-rename="commitRename"
            @cancel-rename="cancelRename"
          >
            <template #title-suffix>
              <button
                v-if="activeWorkPackageHasReadme"
                type="button"
                class="no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-ink-4 hover:bg-chrome-mid hover:text-ink-2"
                title="Open documentation"
                aria-label="Open documentation"
                data-testid="work-header-package-docs"
                @click="openPackageDocs(activeWorkPackageId)"
              >
                <IconHelpCircle :size="13" :stroke-width="1.8" />
              </button>
            </template>
            <!-- The verb lives with the work: starting a fresh chat from an
                 open session. The Navigator's Chat row is the launcher noun. -->
            <template #actions>
              <button
                v-if="activeWork?.kind === 'chat'"
                type="button"
                class="no-drag flex h-6 w-6 items-center justify-center rounded-[5px] text-ink-3 hover:bg-chrome-mid hover:text-ink"
                :title="`New chat (${shortcutLabel(['Mod', 'N'])})`"
                aria-label="New chat"
                data-testid="work-header-new-chat"
                @click="openDraftChatWork"
              >
                <IconMessageCirclePlus :size="13" :stroke-width="1.9" />
              </button>
            </template>
          </PaneHeader>
        </template>

        <InitWorkspaceBanner
          v-if="workspaceStatus && !workspaceStatus.initialized"
          :key="workspacePath ?? 'none'"
          :missing="workspaceStatus.missing"
          @initialize="initializeWorkspace"
        />
        <PaneRecoveryState
          v-if="workNavigationError"
          pane="work"
          :error="workNavigationError"
          :can-back="workCanBack"
          :can-remove="!!activeWork"
          @retry="retryWorkRecovery"
          @back="navigateWorkHistory('back')"
          @remove="removeFailedWorkEntry"
          @dismiss="clearNavigationError('work')"
        />
        <div v-show="!workNavigationError" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkHost
            ref="workHostRef"
            :active-host="activeWorkHost"
            :active-work="activeWork"
            :packages="packages"
            :port="port"
            :recent-files="settingsStore.recentFiles.map(path => ({ path, name: workspaceLabel(path) }))"
            :active-file-path="activeFilePath"
            :files-refresh-key="filesRefreshKey"
            :archive-refresh-key="archiveRefreshKey"
            @open-file="openFileInEditor"
            @open-file-native="openFileInNativeApp"
            @open-file-history="openFileHistory"
            @new-file="createUntitledInEditor"
            @open-file-dialog="openFileViaDialog"
            @path-moved="handleFilePathMoved"
            @open-package="openPackageFromWork"
            @open-session="onArchiveOpenSession"
            @archive-session="archiveSession"
            @open-package-run="openPackageRunWork"
            @open-agent-session="openAgentSessionWork"
            @archive-agent-session="archiveAgentSession"
            @review-approval="reviewApprovalChange"
            @open-settings="openSettings('ai')"
          />
        </div>
      </WorkPane>
    </template>

    <template #artifact>
      <ArtifactPane
        :state="artifactPaneState"
        :expanded="rightExpanded"
        :title="artifactLabel"
        :subtitle="artifactSubtitle"
        :meta="artifactRailMeta"
        @resize="onRightResize"
        @restore="restoreArtifactPane"
      >
        <div
          v-if="artifactNavigationError"
          class="flex min-h-0 min-w-[336px] shrink-0 flex-col overflow-hidden bg-surface"
          :style="artifactFrameStyle"
        >
          <PaneHeader
            pane="artifact"
            :title="artifactLabel"
            :subtitle="artifactSubtitle"
            :can-back="artifactCanBack"
            :can-forward="artifactCanForward"
            :can-collapse="true"
            :can-expand="true"
            :expanded="rightExpanded"
            :show-navigator-restore="showNavigatorRestoreInArtifactHeader"
            :show-work-restore="showNavigatorRestoreInArtifactHeader"
            @back="navigateArtifactHistory('back')"
            @forward="navigateArtifactHistory('forward')"
            @restore-navigator="restoreNavigatorPane"
            @restore-work="restoreWorkPane"
            @collapse="collapseArtifactPane"
            @expand="toggleArtifactExpanded"
          />
          <PaneRecoveryState
            pane="artifact"
            :error="artifactNavigationError"
            :can-back="artifactCanBack"
            :can-remove="!!activeArtifact"
            @retry="retryArtifactRecovery"
            @back="navigateArtifactHistory('back')"
            @remove="removeFailedArtifactEntry"
            @dismiss="clearNavigationError('artifact')"
          />
        </div>
        <ArtifactHost
          v-show="!artifactNavigationError"
          ref="artifactHostRef"
          :active-host-id="activeArtifactHostId"
          :active-artifact="activeArtifact"
          :port="port"
          :packages="packages"
          :width="rightExpanded ? undefined : clampedRightPanelWidth"
          @select-package="openPackageFromWork"
          @open-session="onArchiveOpenSession"
          @open-package-run="openPackageRunWork"
          @artifact-activated="recordMountedArtifactActivation"
          @active-file-changed="handleActiveFileChanged"
          @all-tabs-closed="handleAllDocumentTabsClosed"
          @open-file-dialog="openFileViaDialog"
          @prepare-chat-draft="prepareChatDraft"
          @send-to-terminal="handleSendToTerminal"
        >
          <template #pane-header>
            <PaneHeader
              pane="artifact"
              :title="artifactLabel"
              :subtitle="artifactSubtitle"
              :can-back="artifactCanBack"
              :can-forward="artifactCanForward"
              :can-collapse="true"
              :can-expand="true"
              :expanded="rightExpanded"
              :show-navigator-restore="showNavigatorRestoreInArtifactHeader"
              :show-work-restore="showNavigatorRestoreInArtifactHeader"
              @back="navigateArtifactHistory('back')"
              @forward="navigateArtifactHistory('forward')"
              @restore-navigator="restoreNavigatorPane"
              @restore-work="restoreWorkPane"
              @collapse="collapseArtifactPane"
              @expand="toggleArtifactExpanded"
            />
          </template>
        </ArtifactHost>
      </ArtifactPane>
    </template>

    <template #overlays>
      <SettingsDialog
        v-if="settingsOpen"
        :initial-section="settingsSection"
        @close="settingsOpen = false"
        @open-package="openPackageFromSettings"
        @open-package-docs="openPackageDocsFromSettings"
      />
      <AddProjectDialog
        v-if="addProjectOpen"
        :mode="addProjectMode"
        @close="addProjectOpen = false"
        @created="onProjectCreated"
      />
      <WelcomeDialog
        v-if="welcomeOpen"
        @close="welcomeOpen = false"
        @action="handleWelcomeAction"
      />
      <ShortcutsDialog
        v-if="shortcutsOpen"
        @close="shortcutsOpen = false"
      />
      <CommandPalette
        v-if="paletteOpen"
        :files="fileIndex.files.value.map(f => ({ path: f.path, name: f.name }))"
        :sessions="sessionStore.visibleSessions.map(s => ({ id: s.id, label: s.label }))"
        :agents="appAgentsStore.agents.map(a => ({ id: a.id, name: a.name }))"
        :has-active-editor-tab="paletteEditorTabActive"
        @select="handlePaletteSelect"
        @close="paletteOpen = false"
      />
      <ToastHost />
    </template>
  </WorkbenchShell>
</template>
