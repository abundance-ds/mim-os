import { existsSync } from 'fs'
import { join } from 'path'
import { createTraceLog, type TraceLog } from '@main/trace/trace.js'
import { createTraceOutcomeTracker } from '@main/trace/outcomes.js'
import { loadUserConfig } from '@main/userConfig.js'
import { createToolRegistry, type ToolRegistry } from '@main/tools/registry.js'
import {
  createPermissionGate,
  traceGateDecision,
  type PermissionApprovalRequest,
  type PermissionDecisionEvent,
  type PermissionGate,
} from '@main/security/gate.js'
import { createPackageEnablementStore } from '@main/packages/packageEnablement.js'
import { createPackageLoader, type PackageLoader } from '@main/packages/packages.js'
import { createPackageRuntime } from '@main/packages/packageRuntime.js'
import { createPackageJobRunner } from '@main/packages/packageJobs.js'
import { registerPackageRuntimeTools } from '@main/tools/packageRuntime.js'
import { createNamedPackageToolSync, type NamedPackageToolSync } from '@main/packages/namedPackageTools.js'
import { createAgentContextContributionsProvider, createLocalPackageStatusProvider } from '@main/packages/packageContributions.js'
import { setAgentContextContributionsProvider, setAgentContextLocalPackagesProvider } from '@main/ai/agentContext.js'
import { registerAiTools } from '@main/ai/ai.js'
import { registerArchiveTools } from '@main/tools/archive.js'
import { registerCoreAppTools } from '@main/tools/coreApps.js'
import { createAgentMounts } from '@main/ai/agentMounts.js'
import { registerPackageTools } from '@main/tools/packages.js'
import { registerDocumentTools } from '@main/tools/documents.js'
import { registerExportTools } from '@main/tools/export.js'
import { registerReferencesTools } from '@main/tools/references.js'
import { registerFileTools } from '@main/tools/fs.js'
import { registerCommentTools } from '@main/tools/comments.js'
import { registerSkillTools } from '@main/tools/skills.js'
import { registerLogbookTools } from '@main/tools/logbook.js'
import { registerSearchTools } from '@main/tools/search.js'
import { registerGitTools } from '@main/tools/git.js'
import { registerAwarenessTools } from '@main/tools/awareness.js'
import { registerSyncTools } from '@main/tools/sync.js'
import { registerTeamTools } from '@main/tools/team.js'
import { createTeamSource } from '@main/team/teamSource.js'
import { syncTeamFilesMount } from '@main/team/teamFiles.js'
import { refreshLiveTeamContributions } from '@main/team/liveTeamRefresh.js'
import { registerTraceTools } from '@main/tools/trace.js'
import { createHistoryStore } from '@main/history/history.js'
import { registerHistoryTools } from '@main/tools/history.js'
import {
  readHistoryMaxBytes,
  readHistoryEnabled,
  readTraceCaptureContent,
  readTracePayloadMaxBytes,
  readTracePayloadRetentionDays,
  readTraceRetentionDays,
  registerSettingsTools,
} from '@main/tools/settings.js'
import { registerToolPolicyTools } from '@main/tools/toolPolicy.js'
import { registerToolchainTools } from '@main/tools/toolchain.js'
import { registerCodeTools } from '@main/tools/code.js'
import { registerSlackTools } from '@main/integrations/slack/tools.js'
import { registerGoogleTools } from '@main/integrations/google/tools.js'
import { registerWebTools } from '@main/tools/web.js'
import { registerWorkspaceTools } from '@main/tools/workspace.js'
import { registerSessionTools } from '@main/sessions.js'
import {
  continueRoutineRunInSession,
  createRoutineChatSession,
  registerRoutineTools,
  runRoutineOnce,
  startRoutineRun,
} from '@main/tools/routines.js'
import { createRoutineAutomation } from '@main/routines/automation.js'
import { loadRoutineCatalog } from '@main/routines/routines.js'
import { registerSubagentTools } from '@main/tools/subagents.js'
import { createSubagentManager, type SubagentManager } from '@main/subagents/subagentManager.js'
import { chatProfile } from '@main/ai/aiRuntime.js'
import { parseAllowedHttpUrl } from '@main/web/urlPolicy.js'
import { addBrowserSessionDomain, isBrowserSessionAllowed, readBrowserSessionSettings } from '@main/web/browserSessionSettings.js'
import { resolveTelemetryConfig } from '@main/telemetry/config.js'
import { readTelemetryIdentity, setTelemetryIdentityEnabled } from '@main/telemetry/identity.js'
import { createTelemetry } from '@main/telemetry/telemetry.js'
import { registerTelemetryTools } from '@main/tools/telemetry.js'
import type { HttpClient } from '@main/integrations/http.js'
import { createKeytarSecretStore } from '@main/integrations/secrets.js'
import { SlackIntegration } from '@main/integrations/slack/client.js'
import { createSlackSocketModeListener } from '@main/integrations/slack/listener.js'
import { createBackgroundSync } from '@main/sync/backgroundSync.js'
import { userHomeDir } from '@main/platform.js'
import { createServer, type McpToolSpec } from '@main/server/server.js'

export interface HeadlessAlwaysOnStatus {
  running: boolean
  host: string | null
  port: number | null
  startedAt: string | null
  heartbeatAt: string | null
  lastError: string | null
}

export interface HeadlessKernel {
  tools: ToolRegistry
  getPackages(): PackageLoader
  getNamedMcpTools(): McpToolSpec[]
  getAgentMounts(): ReturnType<typeof createAgentMounts> | null
  openWorkspace(path: string): Promise<void>
  startAlwaysOn(options?: { host?: string; port?: number; tickMs?: number }): Promise<HeadlessAlwaysOnStatus>
  alwaysOnStatus(): HeadlessAlwaysOnStatus
  shutdown(): Promise<void>
}

export interface HeadlessKernelOptions {
  approvals?: 'deny' | 'prompt' | 'allow'
  confirmApproval?: (request: PermissionApprovalRequest) => Promise<boolean>
  onGateDecision?: (event: PermissionDecisionEvent) => void
  telemetry?: {
    enabled?: boolean
    endpoint?: string
    appVersion?: string
    allowInTests?: boolean
    http?: HttpClient
  }
}

export function createHeadlessKernel(options: HeadlessKernelOptions = {}): HeadlessKernel {
  let tools!: ToolRegistry
  const HOME = userHomeDir()
  const telemetryConfig = resolveTelemetryConfig({
    home: HOME,
    allowInTests: options.telemetry?.allowInTests,
  })
  let telemetryIdentity = telemetryConfig.disabled
    ? null
    : readTelemetryIdentity({ home: HOME })
  const telemetry = createTelemetry({
    http: options.telemetry?.http,
    appVersion: options.telemetry?.appVersion ?? process.env.npm_package_version ?? '0.1.0',
    platform: telemetryConfig.platform,
    runtime: 'headless',
    anonId: telemetryIdentity?.anonId ?? 'disabled',
    enabled: (options.telemetry?.enabled ?? telemetryIdentity?.enabled ?? false) && !telemetryConfig.disabled,
    locked: telemetryConfig.locked,
    endpoint: options.telemetry?.endpoint ?? telemetryConfig.endpoint,
    onEnabledChange: (enabled) => {
      telemetryIdentity = setTelemetryIdentityEnabled(enabled, { home: HOME })
    },
  })
  const traceLog = createTraceLog({
    sinks: [telemetry.createTelemetrySink()],
    devConsole: false,
    getPrincipal: () => {
      const user = loadUserConfig().user
      return user.email ?? user.name
    },
    getRetentionDays: () => readTraceRetentionDays(tools?.getWorkspacePath() ?? null),
    getPayloadRetentionDays: () => readTracePayloadRetentionDays(tools?.getWorkspacePath() ?? null),
    getPayloadMaxBytes: () => readTracePayloadMaxBytes(tools?.getWorkspacePath() ?? null),
  })
  let packages: Awaited<ReturnType<typeof createPackageLoader>> | null = null
  let packageEnablement: ReturnType<typeof createPackageEnablementStore> | null = null
  // Per-kernel, not module-scope: tests create several kernels in one process.
  let namedToolsRef: NamedPackageToolSync | null = null
  let agentMountsRef: ReturnType<typeof createAgentMounts> | null = null
  let subagentManagerRef: SubagentManager | null = null
  let routineAutomation: ReturnType<typeof createRoutineAutomation> | null = null
  let slackListener: ReturnType<typeof createSlackSocketModeListener> | null = null
  let backgroundSync: ReturnType<typeof createBackgroundSync> | null = null
  let alwaysOnServer: Awaited<ReturnType<typeof createServer>> | null = null
  let alwaysOnTicker: ReturnType<typeof setInterval> | null = null
  let alwaysOnCycle: Promise<void> | null = null
  let alwaysOnState: HeadlessAlwaysOnStatus = {
    running: false,
    host: null,
    port: null,
    startedAt: null,
    heartbeatAt: null,
    lastError: null,
  }
  const packageSecretStore = createKeytarSecretStore()
  const gate = createHeadlessGate(
    () => tools.getWorkspacePath(),
    options,
    traceLog,
    (name) => namedToolsRef?.getPolicy(name),
    (sessionId, data) => {
      void tools.call('session.update', { id: sessionId, ...data }, { actor: 'system' }).catch(() => {})
    },
    (sessionId, status, error) => {
      void subagentManagerRef?.markApproval(sessionId, status, error)
    },
  )
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

  registerFileTools(tools)
  registerCommentTools(tools)
  registerWorkspaceTools(tools)
  registerSettingsTools(tools)
  registerToolPolicyTools(tools)
  registerToolchainTools(tools)
  registerCodeTools(tools)
  registerSessionTools(tools)
  subagentManagerRef = createSubagentManager({
    tools,
    cancelApprovals: sessionId => gate.cancelSession(sessionId),
    getAgentProfile: async (agentId) => {
      if (!agentId) return chatProfile
      if (!agentMountsRef) throw new Error('Agent profiles are not available until a workspace is open')
      return agentMountsRef.resolveProfile(agentId)
    },
  })
  registerSubagentTools(tools, subagentManagerRef)
  registerRoutineTools(tools, {
    getAgentMounts: () => agentMountsRef,
    runRoutine: (routine, context) => runRoutineOnce(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
    startRoutine: (routine, context) => createRoutineChatSession(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
    secrets: packageSecretStore,
    onChange: async () => {
      await routineAutomation?.refresh()
      await slackListener?.refresh()
    },
  })
  registerArchiveTools(tools)
  registerAiTools(tools)
  registerSearchTools(tools)
  registerGitTools(tools)
  registerAwarenessTools(tools)
  registerSyncTools(tools)
  const teamSource = createTeamSource({ homeDir: HOME })
  async function syncCurrentTeamMount(): Promise<void> {
    const workspace = tools.getWorkspacePath()
    if (!workspace) return
    let team = null
    try {
      team = await teamSource.open()
    } catch {
      // Team is optional; a Project can always open without it.
    }
    syncTeamFilesMount(workspace, team)
  }
  registerTeamTools(tools, {
    source: teamSource,
    onChanged: async () => {
      await refreshLiveTeamContributions({
        syncMount: syncCurrentTeamMount,
        rescanApps: async () => { await packages?.rescan() },
        syncNamedTools: async () => { await namedToolsRef?.sync() },
        refreshRoutines: async () => { await routineAutomation?.refresh() },
        refreshSlack: async () => { await slackListener?.refresh() },
      })
    },
    emit: (channel, payload) => {
      alwaysOnServer?.broadcast(channel, payload ?? {})
    },
  })
  registerTraceTools(tools)
  registerHistoryTools(tools, history)
  registerDocumentTools(tools)
  // No hidden render window headless: export.docx works, export.pdf reports
  // its unavailability.
  registerExportTools(tools)
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
  })
  registerLogbookTools(tools)
  registerWebTools(tools)
  registerSlackTools(tools)
  registerGoogleTools(tools)
  registerTelemetryTools(tools, telemetry)
  registerCoreAppTools(tools)
  tools.register({
    name: 'always-on.status',
    description: 'Read this headless client runtime state.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ...alwaysOnState, slack: slackListener?.status() ?? null }),
  })
  telemetry.track('app_open', {
    appVersion: options.telemetry?.appVersion ?? process.env.npm_package_version ?? '0.1.0',
    platform: telemetryConfig.platform,
    runtime: 'headless',
  })

  return {
    tools,
    getPackages() {
      if (!packages) throw new Error('No workspace open')
      return packages
    },
    getNamedMcpTools() {
      const specs: McpToolSpec[] = []
      const seen = new Set<string>()
      const pushSpec = (name: string) => {
        if (seen.has(name)) return
        seen.add(name)
        const tool = tools.get(name)
        if (tool) specs.push({ name: name.replace(/\./g, '_'), mimName: name, description: tool.description })
      }
      for (const name of namedToolsRef?.ownedNames() ?? []) pushSpec(name)
      return specs
    },
    getAgentMounts() {
      return agentMountsRef
    },
    async openWorkspace(path: string) {
      await subagentManagerRef?.interruptActive()
      await tools.call('workspace.open', { path }, { actor: 'system' })
      await syncCurrentTeamMount()
      telemetry.track('workspace_open')
      const enablement = createPackageEnablementStore({
        getWorkspacePath: () => tools.getWorkspacePath(),
      })
      packageEnablement = enablement
      packages = await createPackageLoader(tools)
      const runtime = createPackageRuntime({ packages, enablement, tools, trace: traceLog, secrets: packageSecretStore })
      const jobs = createPackageJobRunner({ runtime, getWorkspacePath: () => tools.getWorkspacePath(), emit: () => {}, trace: traceLog })
      registerPackageRuntimeTools(tools, packages, runtime, jobs, {})

      const namedTools = createNamedPackageToolSync({ runtime, tools, packages })
      namedToolsRef = namedTools
      registerPackageTools(tools, packages, enablement, {
        invalidate: (id) => runtime.invalidate(id),
        syncNamedTools: () => namedTools.sync(),
      })

      const agentMounts = createAgentMounts({ runtime, packages, tools })
      agentMountsRef = agentMounts
      registerCoreAppTools(tools, {
        packages,
        enablement,
        invalidate: (id) => { runtime.invalidate(id); void namedTools.sync() },
        agentMounts,
      })

      setAgentContextContributionsProvider(createAgentContextContributionsProvider({ runtime, packages }))
      setAgentContextLocalPackagesProvider(createLocalPackageStatusProvider({ runtime, packages, enablement }))
      await namedTools.sync()
      await subagentManagerRef?.reconcile()
      routineAutomation = createRoutineAutomation({
        getWorkspacePath: () => tools.getWorkspacePath(),
        runRoutine: (routine, context) => runRoutineOnce(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
        knownTools: () => new Set(tools.list().map(tool => tool.name)),
        secrets: packageSecretStore,
        trace: traceLog,
      })
      slackListener = createSlackSocketModeListener({
        getWorkspacePath: () => tools.getWorkspacePath(),
        getRoutines: () => {
          const workspace = tools.getWorkspacePath()
          return workspace
            ? loadRoutineCatalog(workspace, { knownTools: new Set(tools.list().map(tool => tool.name)) }).routines
            : []
        },
        runRoutine: (routine, context) => runRoutineOnce(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
        startRoutine: (routine, context) => startRoutineRun(tools, routine, context, { getAgentMounts: () => agentMountsRef }),
        continueRoutine: (routine, context, thread) =>
          continueRoutineRunInSession(tools, routine, context, thread.sessionId, { getAgentMounts: () => agentMountsRef }),
        getSessionReplyText: sessionId => latestAssistantReply(tools, sessionId),
        slack: new SlackIntegration({ secrets: packageSecretStore }),
        trace: traceLog,
      })
    },
    async startAlwaysOn(runtimeOptions = {}) {
      if (!packages || !tools.getWorkspacePath() || !routineAutomation || !slackListener) {
        throw new Error('Open a Project before starting the always-on client')
      }
      if (alwaysOnState.running) return { ...alwaysOnState }
      const host = runtimeOptions.host ?? '127.0.0.1'
      const tickMs = Math.max(1_000, runtimeOptions.tickMs ?? 60_000)
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
        },
        syncTeam: async () => {
          const current = await tools.call('team.status', {}, { actor: 'system' }) as {
            repository?: string | null
            state?: string
            dirty?: boolean
            ahead?: number
            retryable?: boolean
          }
          if (!current.repository || current.state === 'invalid' || (current.state === 'stopped' && !current.retryable)) return
          if (current.dirty || (current.ahead ?? 0) > 0) {
            const published = await teamSource.publish()
            if (published.retryable) {
              throw new Error(published.message ?? 'Team publishing is waiting to retry')
            }
          }
          await tools.call('team.check', {}, { actor: 'system' })
        },
        onError: (_scope, error) => {
          alwaysOnState.lastError = error instanceof Error ? error.message : String(error)
        },
      })
      alwaysOnServer = await createServer(tools, packages, {
        host,
        port: runtimeOptions.port ?? 0,
        getNamedMcpTools: () => {
          const specs: McpToolSpec[] = []
          for (const name of namedToolsRef?.ownedNames() ?? []) {
            const tool = tools.get(name)
            if (tool) specs.push({ name: name.replace(/\./g, '_'), mimName: name, description: tool.description })
          }
          return specs
        },
        agentMounts: agentMountsRef ?? undefined,
        handleRoutineWebhook: (name, delivery) => routineAutomation!.handleWebhook(name, delivery),
      })
      alwaysOnState = {
        running: true,
        host,
        port: alwaysOnServer.port,
        startedAt: new Date().toISOString(),
        heartbeatAt: null,
        lastError: null,
      }
      await routineAutomation.start()
      await runAlwaysOnCycle()
      alwaysOnTicker = setInterval(() => void runAlwaysOnCycle(), tickMs)
      return { ...alwaysOnState }
    },
    alwaysOnStatus() {
      return { ...alwaysOnState }
    },
    async shutdown() {
      if (alwaysOnTicker) clearInterval(alwaysOnTicker)
      alwaysOnTicker = null
      await alwaysOnCycle?.catch(() => {})
      await backgroundSync?.beforeClose().catch(() => {})
      backgroundSync?.stop()
      backgroundSync = null
      await routineAutomation?.stop()
      await slackListener?.stop()
      routineAutomation = null
      slackListener = null
      alwaysOnServer?.close()
      alwaysOnServer = null
      alwaysOnState = { ...alwaysOnState, running: false }
      await subagentManagerRef?.dispose()
      namedToolsRef = null
      agentMountsRef = null
      packageEnablement = null
      setAgentContextContributionsProvider(null)
      setAgentContextLocalPackagesProvider(null)
      await Promise.allSettled([
        telemetry.shutdown(),
        packages?.close?.(),
      ])
      packages = null
      subagentManagerRef = null
    },
  }

  async function runAlwaysOnCycle(): Promise<void> {
    if (alwaysOnCycle) return alwaysOnCycle
    alwaysOnCycle = (async () => {
      const errors: string[] = []
      for (const action of [
        () => backgroundSync?.open(),
        () => routineAutomation?.refresh(),
        () => slackListener?.refresh(),
        () => routineAutomation?.tick(),
      ]) {
        try {
          await action()
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      alwaysOnState.heartbeatAt = new Date().toISOString()
      alwaysOnState.lastError = errors[0] ?? null
    })().finally(() => {
      alwaysOnCycle = null
    })
    return alwaysOnCycle
  }
}

function createHeadlessGate(
  getWorkspacePath: () => string | null,
  options: HeadlessKernelOptions,
  traceLog: TraceLog,
  getDynamicToolPolicy: (name: string) => ReturnType<NamedPackageToolSync['getPolicy']>,
  updateRoutineSession: (sessionId: string, data: Record<string, unknown>) => void,
  updateSubagentApproval: (sessionId: string, status: 'needs-approval' | 'working' | 'error', error?: string) => void,
): PermissionGate {
  const approvals = options.approvals ?? 'deny'
  let gate!: PermissionGate

  gate = createPermissionGate({
    getApprovalMode: () => 'normal',
    getWorkspacePath,
    getDynamicToolPolicy,
    resolveSavedBrowserSessionGrant: (toolName, params) => {
      if ((toolName !== 'web.read' && toolName !== 'web.live.open') || params.stateful !== true || typeof params.url !== 'string') return null
      const ws = getWorkspacePath()
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
      const ws = getWorkspacePath()
      if (!ws) throw new Error('No workspace open')
      addBrowserSessionDomain(ws, grant.domain)
    },
    onApprovalRequested: (request) => {
      if (request.sessionId && request.subagentRootSessionId) updateSubagentApproval(request.sessionId, 'needs-approval')
      if (!request.routineId || !request.sessionId) return
      updateRoutineSession(request.sessionId, { routineStatus: 'needs-approval' })
    },
    onApprovalResolved: (request, decision) => {
      if (request.sessionId && request.subagentRootSessionId) {
        updateSubagentApproval(request.sessionId, 'working')
      }
      if (!request.routineId || !request.sessionId) return
      if (decision.approved) {
        updateRoutineSession(request.sessionId, { routineStatus: 'working', routineError: '' })
      } else {
        updateRoutineSession(request.sessionId, {
          routineStatus: 'error',
          routineError: 'Approval denied',
          routineCompletedAt: new Date().toISOString(),
        })
      }
    },
    recordDecision: (event) => {
      traceGateDecision(traceLog, event)
      options.onGateDecision?.(event)
    },
    sendApprovalRequest(request) {
      if (approvals === 'deny') return false
      queueMicrotask(async () => {
        try {
          const approved = approvals === 'allow'
            ? true
            : await (options.confirmApproval?.(request) ?? Promise.resolve(false))
          gate.respond(request.requestId, { approved })
        } catch {
          gate.respond(request.requestId, { approved: false })
        }
      })
      return true
    },
  })

  return gate
}

async function latestAssistantReply(tools: ToolRegistry, sessionId: string): Promise<string | null> {
  const session = await tools.call('session.get', { id: sessionId }, { actor: 'system' }) as {
    messages?: Array<{ role?: unknown; parts?: Array<{ type?: unknown; text?: unknown }>; content?: unknown }>
  }
  for (const message of [...(session.messages ?? [])].reverse()) {
    if (message.role !== 'assistant') continue
    const parts = Array.isArray(message.parts)
      ? message.parts
          .filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => String(part.text))
          .join('\n')
          .trim()
      : ''
    if (parts) return parts
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim()
  }
  return null
}
