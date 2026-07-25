import { randomUUID } from 'crypto'
import { classifyPermissionPath, type PermissionPathClassification, type PermissionPathKind } from '@main/security/gate-paths.js'
import type { PackagePermissions } from '@main/packages/packageManifest.js'
import type { ToolContext, ToolDef } from '@main/tools/registry.js'
import type { TraceLog } from '@main/trace/trace.js'

export type ApprovalMode = 'normal' | 'strict' | 'developer'
export type ToolRisk = 'low' | 'medium' | 'high'
export type ToolCategory = 'read' | 'write' | 'system' | 'settings' | 'ui' | 'ai' | 'search' | 'network' | 'secrets' | 'general'
export type PermissionDecisionKind = 'allowed' | 'requested' | 'approved' | 'denied' | 'bypassed'

// What a file-mutating action will do, carried to the UI so the user can see the
// actual change before approving. Sourced from the raw (un-redacted) params: this
// is the user's own file content shown back to them, and it never enters the audit
// log (the recorded event keeps the redacted params).
export type ApprovalPreview =
  | { kind: 'edit'; oldText: string; newText: string }
  | { kind: 'write'; content: string }
  | { kind: 'create'; content: string }
  | { kind: 'delete' }

export interface SavedBrowserSessionApproval {
  domain: string
  granted: boolean
}

export interface ToolPolicy {
  category: ToolCategory
  risk: ToolRisk
  label?: string
  ownerPackageId?: string
  pathParam?: string
  // A second path-bearing param (e.g. fs.rename new_path) that must pass the
  // same path protections as the primary path.
  secondaryPathParam?: string
  targetParam?: string
}

export interface PermissionApprovalRequest {
  requestId: string
  toolName: string
  actor: ToolContext['actor']
  package_id?: string
  sessionId?: string
  routineId?: string
  routineRunId?: string
  subagentRootSessionId?: string
  subagentParentSessionId?: string
  subagentDepth?: number
  category: ToolCategory
  risk: ToolRisk
  mode: ApprovalMode
  reason: string
  target?: string
  pathKind?: PermissionPathKind
  // Human-readable action label from the resolved tool policy (e.g. "Board: Delete issue").
  label?: string
  params: Record<string, unknown>
  preview?: ApprovalPreview
  savedBrowserSession?: SavedBrowserSessionApproval
}

export interface PermissionApprovalDecision {
  approved: boolean
  alwaysAllow?: boolean
}

export interface PermissionDecisionEvent {
  decision: PermissionDecisionKind
  tool: string
  actor: ToolContext['actor']
  package_id?: string
  sessionId?: string
  routineId?: string
  routineRunId?: string
  subagentRootSessionId?: string
  subagentParentSessionId?: string
  subagentDepth?: number
  // Trace context of the tool call being gated, so the recorded decision
  // parents under the tool span in the unified trace stream.
  traceId?: string
  parentSpanId?: string
  category: ToolCategory
  risk: ToolRisk
  mode: ApprovalMode
  reason: string
  target?: string
  pathKind?: PermissionPathKind
  params?: Record<string, unknown>
}

export interface PermissionGate {
  check(tool: ToolDef, params: Record<string, unknown>, ctx: ToolContext): Promise<void>
  respond(requestId: string, decision: PermissionApprovalDecision): boolean
  cancelSession(sessionId: string): void
}

export interface PermissionGateOptions {
  getApprovalMode: () => ApprovalMode | Promise<ApprovalMode>
  getWorkspacePath: () => string | null
  getPackagePermissions?: (packageId: string) => PackagePermissions | undefined
  // App-provided tools register per-tool policies at runtime. Consulted
  // after the static TOOL_POLICIES map: core tool policies cannot be overridden
  // by an app (security property).
  getDynamicToolPolicy?: (toolName: string) => ToolPolicy | undefined
  resolveSavedBrowserSessionGrant?: (
    toolName: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
  ) => SavedBrowserSessionApproval | null | undefined | Promise<SavedBrowserSessionApproval | null | undefined>
  grantSavedBrowserSessionDomain?: (
    grant: SavedBrowserSessionApproval,
    params: Record<string, unknown>,
    ctx: ToolContext,
  ) => void | Promise<void>
  onApprovalRequested?: (request: PermissionApprovalRequest) => void | Promise<void>
  onApprovalResolved?: (
    request: PermissionApprovalRequest,
    decision: PermissionApprovalDecision,
  ) => void | Promise<void>
  sendApprovalRequest: (request: PermissionApprovalRequest) => boolean
  recordDecision?: (event: PermissionDecisionEvent) => void
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

const TOOL_POLICIES: Record<string, ToolPolicy> = {
  'fs.read': { category: 'read', risk: 'low', pathParam: 'path' },
  'fs.readImageDataUrl': { category: 'read', risk: 'low', pathParam: 'path' },
  'fs.list': { category: 'read', risk: 'low', pathParam: 'path' },
  'fs.exists': { category: 'read', risk: 'low', pathParam: 'path' },
  'fs.openNative': { category: 'read', risk: 'low', pathParam: 'path' },
  'fs.write': { category: 'write', risk: 'medium', pathParam: 'path' },
  'fs.writeBytes': { category: 'write', risk: 'medium', pathParam: 'path' },
  'fs.edit': { category: 'write', risk: 'medium', pathParam: 'path' },
  'fs.create': { category: 'write', risk: 'medium', pathParam: 'path' },
  'fs.mkdir': { category: 'write', risk: 'medium', pathParam: 'path' },
  'fs.rename': { category: 'write', risk: 'medium', pathParam: 'old_path', secondaryPathParam: 'new_path' },
  'fs.delete': { category: 'write', risk: 'high', pathParam: 'path' },
  'fs.trash': { category: 'write', risk: 'medium', pathParam: 'path' },
  'fs.copy': { category: 'write', risk: 'medium', pathParam: 'path', secondaryPathParam: 'new_path' },
  'fs.import': { category: 'write', risk: 'medium', pathParam: 'dest_dir' },
  'history.list': { category: 'read', risk: 'low', pathParam: 'path' },
  'history.preview': { category: 'read', risk: 'low', pathParam: 'path' },
  'history.stats': { category: 'read', risk: 'low' },
  'history.baseline': { category: 'general', risk: 'low' },
  'history.openVersion': { category: 'read', risk: 'low', pathParam: 'path' },
  'history.restore': { category: 'write', risk: 'medium', pathParam: 'path' },
  'history.prune': { category: 'settings', risk: 'medium' },
  'history.clear': { category: 'settings', risk: 'medium' },
  'git.status': { category: 'read', risk: 'low' },
  'awareness.recent': { category: 'read', risk: 'low' },
  'always-on.status': { category: 'read', risk: 'low' },
  'git.diff': { category: 'read', risk: 'low', pathParam: 'path' },
  'git.log': { category: 'read', risk: 'low' },
  'git.commit': { category: 'write', risk: 'medium', targetParam: 'message' },
  'git.pull': { category: 'network', risk: 'medium' },
  'git.push': { category: 'network', risk: 'high' },
  'sync.status': { category: 'read', risk: 'low' },
  'sync.configure': { category: 'settings', risk: 'high', targetParam: 'mode' },
  'sync.now': { category: 'network', risk: 'medium' },
  'comments.list': { category: 'read', risk: 'low', pathParam: 'path' },
  'comments.add': { category: 'write', risk: 'medium', pathParam: 'path' },
  'comments.reply': { category: 'write', risk: 'medium', pathParam: 'path' },
  'comments.resolve': { category: 'write', risk: 'medium', pathParam: 'path' },
  'terminal.spawn': { category: 'system', risk: 'high', targetParam: 'cwd' },
  'terminal.write': { category: 'system', risk: 'high', targetParam: 'data' },
  'terminal.run': { category: 'system', risk: 'high', targetParam: 'command' },
  'terminal.resize': { category: 'system', risk: 'low' },
  'terminal.kill': { category: 'system', risk: 'medium', targetParam: 'id' },
  'package.create': { category: 'write', risk: 'medium', targetParam: 'id' },
  'package.validate': { category: 'read', risk: 'low', targetParam: 'id' },
  'package.reload': { category: 'settings', risk: 'medium', targetParam: 'id' },
  'package.edit': { category: 'write', risk: 'medium', targetParam: 'file' },
  'package.delete': { category: 'write', risk: 'high', targetParam: 'id' },
  'package.list': { category: 'read', risk: 'low' },
  'package.readme': { category: 'read', risk: 'low', targetParam: 'id' },
  'package.capabilities.list': { category: 'read', risk: 'low' },
  'package.tools.list': { category: 'read', risk: 'low' },
  'package.tools.execute': { category: 'general', risk: 'low', targetParam: 'name' },
  'package.jobs.start': { category: 'general', risk: 'low', targetParam: 'jobId' },
  'package.jobs.cancel': { category: 'general', risk: 'low', targetParam: 'runId' },
  'package.jobs.get': { category: 'read', risk: 'low', targetParam: 'runId' },
  'package.jobs.list': { category: 'read', risk: 'low', targetParam: 'packageId' },
  'package.jobs.rename': { category: 'ui', risk: 'low', targetParam: 'runId' },
  'package.jobs.archive': { category: 'ui', risk: 'low', targetParam: 'runId' },
  'package.jobs.restore': { category: 'ui', risk: 'low', targetParam: 'runId' },
  'package.jobs.delete': { category: 'ui', risk: 'medium', targetParam: 'runId' },
  'agent.list': { category: 'read', risk: 'low' },
  'agent.launch': { category: 'general', risk: 'medium', targetParam: 'agentId' },
  'agent.stop': { category: 'general', risk: 'medium', targetParam: 'sessionId' },
  'agent.sessions.list': { category: 'read', risk: 'low' },
  'agent.sessions.get': { category: 'read', risk: 'low', targetParam: 'sessionId' },
  'agent.sessions.rename': { category: 'ui', risk: 'low', targetParam: 'sessionId' },
  'agent.sessions.archive': { category: 'ui', risk: 'low', targetParam: 'sessionId' },
  'agent.sessions.delete': { category: 'ui', risk: 'medium', targetParam: 'sessionId' },
  'workbench.openWork': { category: 'ui', risk: 'low', targetParam: 'packageId' },
  'workbench.openArtifact': { category: 'ui', risk: 'low', targetParam: 'packageId' },
  'package.secrets.set': { category: 'secrets', risk: 'high', targetParam: 'name' },
  'package.secrets.delete': { category: 'secrets', risk: 'high', targetParam: 'name' },
  'package.secrets.status': { category: 'read', risk: 'low' },
  'package.data.kv.get': { category: 'read', risk: 'low', targetParam: 'key' },
  'package.data.kv.set': { category: 'write', risk: 'medium', targetParam: 'key' },
  'package.data.kv.delete': { category: 'write', risk: 'medium', targetParam: 'key' },
  'package.data.kv.keys': { category: 'read', risk: 'low' },
  'package.data.collection.list': { category: 'read', risk: 'low', targetParam: 'collection' },
  'package.data.collection.get': { category: 'read', risk: 'low', targetParam: 'id' },
  'package.data.collection.put': { category: 'write', risk: 'medium', targetParam: 'id' },
  'package.data.collection.delete': { category: 'write', risk: 'medium', targetParam: 'id' },
  'workspace.open': { category: 'system', risk: 'medium', pathParam: 'path' },
  'workspace.info': { category: 'read', risk: 'low' },
  // Regenerates the gitignored .mim/agent-context.md from existing workspace
  // state. Benign, low-risk; no approval prompt for user/AI/app.
  'workspace.orient': { category: 'general', risk: 'low' },
  'toolchain.status': { category: 'read', risk: 'low' },
  'code.run': { category: 'system', risk: 'high', targetParam: 'argv' },
  'shell.run': { category: 'system', risk: 'high', targetParam: 'command' },
  'log.append': { category: 'write', risk: 'low', targetParam: 'message' },
  'log.read': { category: 'read', risk: 'low' },
  'slack.setToken': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'slack.deleteToken': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'slack.status': { category: 'network', risk: 'low', targetParam: 'account' },
  'slack.channels': { category: 'network', risk: 'medium', targetParam: 'account' },
  'slack.users': { category: 'network', risk: 'medium', targetParam: 'account' },
  'slack.dms': { category: 'network', risk: 'medium', targetParam: 'account' },
  'slack.history': { category: 'network', risk: 'medium', targetParam: 'channel' },
  'slack.search': { category: 'network', risk: 'medium', targetParam: 'query' },
  'slack.send': { category: 'network', risk: 'high', targetParam: 'channel' },
  'slack.connect': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'slack.disconnect': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'slack.replies': { category: 'network', risk: 'medium', targetParam: 'channel' },
  'slack.bot.status': { category: 'network', risk: 'low', targetParam: 'account' },
  'slack.bot.connect': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'slack.bot.disconnect': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'slack.bot.setup': { category: 'secrets', risk: 'high', targetParam: 'channel' },
  'slack.bot.check': { category: 'network', risk: 'low', targetParam: 'channel' },
  'slack.listener.status': { category: 'network', risk: 'low', targetParam: 'account' },
  'google.setOAuthClient': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'google.setTokenBundle': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'google.connect': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'google.disconnect': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'google.status': { category: 'network', risk: 'low', targetParam: 'account' },
  'google.authUrl': { category: 'secrets', risk: 'medium', targetParam: 'account' },
  'google.exchangeCode': { category: 'secrets', risk: 'high', targetParam: 'account' },
  'gmail.search': { category: 'network', risk: 'medium', targetParam: 'query' },
  'gmail.read': { category: 'network', risk: 'medium', targetParam: 'messageId' },
  'gmail.send': { category: 'network', risk: 'high', targetParam: 'to' },
  'calendar.events': { category: 'network', risk: 'medium', targetParam: 'calendarId' },
  'calendar.create': { category: 'network', risk: 'high', targetParam: 'summary' },
  'drive.search': { category: 'network', risk: 'medium', targetParam: 'query' },
  'drive.meta': { category: 'network', risk: 'medium', targetParam: 'fileId' },
  'docs.read': { category: 'network', risk: 'medium', targetParam: 'fileId' },
  'sheets.meta': { category: 'network', risk: 'medium', targetParam: 'spreadsheetId' },
  'sheets.read': { category: 'network', risk: 'medium', targetParam: 'spreadsheetId' },
  'sheets.write': { category: 'network', risk: 'high', targetParam: 'spreadsheetId' },
  'sheets.append': { category: 'network', risk: 'high', targetParam: 'spreadsheetId' },
  'settings.get': { category: 'settings', risk: 'low', targetParam: 'key' },
  'settings.set': { category: 'settings', risk: 'medium', targetParam: 'key' },
  'toolPolicy.get': { category: 'settings', risk: 'low' },
  'toolPolicy.set': { category: 'settings', risk: 'medium', targetParam: 'rowId' },
  'session.create': { category: 'ui', risk: 'low' },
  'session.list': { category: 'read', risk: 'low' },
  'session.get': { category: 'read', risk: 'low', targetParam: 'id' },
  'session.update': { category: 'ui', risk: 'low', targetParam: 'id' },
  'session.reorder': { category: 'ui', risk: 'low' },
  'session.delete': { category: 'ui', risk: 'medium', targetParam: 'id' },
  'routine.list': { category: 'read', risk: 'low' },
  'routine.get': { category: 'read', risk: 'low', targetParam: 'name' },
  'routine.create': { category: 'write', risk: 'medium', targetParam: 'name' },
  'routine.update': { category: 'write', risk: 'medium', targetParam: 'name' },
  'routine.duplicate': { category: 'write', risk: 'medium', targetParam: 'newName' },
  'routine.enable': { category: 'settings', risk: 'medium', targetParam: 'name' },
  'routine.disable': { category: 'settings', risk: 'medium', targetParam: 'name' },
  'routine.remove': { category: 'write', risk: 'high', targetParam: 'name' },
  'routine.run': { category: 'general', risk: 'medium', targetParam: 'name' },
  'subagent.spawn': { category: 'general', risk: 'medium', targetParam: 'label' },
  'subagent.wait': { category: 'read', risk: 'low' },
  'subagent.send': { category: 'general', risk: 'low', targetParam: 'sessionId' },
  'subagent.interrupt': { category: 'general', risk: 'medium', targetParam: 'sessionId' },
  'subagent.stop': { category: 'general', risk: 'medium', targetParam: 'sessionId' },
  'subagent.status': { category: 'read', risk: 'low', targetParam: 'sessionId' },
  'subagent.list': { category: 'read', risk: 'low' },
  'subagent.result': { category: 'read', risk: 'low', targetParam: 'sessionId' },
  'routine.start': { category: 'general', risk: 'medium', targetParam: 'name' },
  'chat.send': { category: 'ui', risk: 'low' },
  'editor.open': { category: 'ui', risk: 'low', pathParam: 'path' },
  'editor.state': { category: 'read', risk: 'low' },
  'ai.registry': { category: 'ai', risk: 'low' },
  'ai.keyStatus': { category: 'ai', risk: 'low' },
  'ai.setKey': { category: 'settings', risk: 'medium', targetParam: 'provider' },
  'ai.generateObject': { category: 'ai', risk: 'low', targetParam: 'modelId' },
  'documents.docx.read': { category: 'read', risk: 'low', pathParam: 'path' },
  'documents.docx.extract': { category: 'read', risk: 'low', pathParam: 'path' },
  'documents.pdf.extract': { category: 'read', risk: 'low', pathParam: 'path' },
  'documents.docx.comments': { category: 'read', risk: 'low', pathParam: 'path' },
  'documents.docx.validate': { category: 'read', risk: 'low', pathParam: 'path' },
  'documents.docx.annotate': { category: 'write', risk: 'medium', pathParam: 'path' },
  'documents.docx.workerStatus': { category: 'read', risk: 'low' },
  'documents.importMarkdown': { category: 'write', risk: 'medium', pathParam: 'output_path' },
  'documents.importMarkdown.formats': { category: 'read', risk: 'low' },
  // Reads a workspace HTML file and writes the rendered PDF next to it.
  'render.htmlToPdf': { category: 'write', risk: 'medium', pathParam: 'path' },
  // Read a markdown source, write the exported document into the workspace.
  'export.pdf': { category: 'write', risk: 'low', pathParam: 'output_path' },
  'export.docx': { category: 'write', risk: 'low', pathParam: 'output_path' },
  'export.styles': { category: 'read', risk: 'low' },
  'references.readBib': { category: 'read', risk: 'low', pathParam: 'path' },
  'references.resolveBibliography': { category: 'settings', risk: 'low', targetParam: 'path' },
  'references.setBibliographyPath': { category: 'settings', risk: 'medium', pathParam: 'path' },
  'documents.pickReviewFile': { category: 'write', risk: 'low' },
  'documents.pickImportFile': { category: 'write', risk: 'low' },
  'search.sessions': { category: 'search', risk: 'low', targetParam: 'query' },
  'search.files': { category: 'search', risk: 'low', targetParam: 'query' },
  search: { category: 'search', risk: 'low', targetParam: 'query' },
  'trace.query': { category: 'read', risk: 'low' },
  'trace.stats': { category: 'read', risk: 'low' },
  'trace.storage': { category: 'read', risk: 'low' },
  'trace.prune': { category: 'settings', risk: 'medium' },
  'telemetry.track': { category: 'ui', risk: 'low' },
  'telemetry.status': { category: 'read', risk: 'low' },
  'telemetry.setEnabled': { category: 'settings', risk: 'medium' },
  'config.get': { category: 'read', risk: 'low' },
  'config.setUser': { category: 'settings', risk: 'medium' },
  'system.prompt': { category: 'read', risk: 'low' },
  'skill.list': { category: 'read', risk: 'low' },
  'skill.get': { category: 'read', risk: 'low', targetParam: 'name' },
  'skill.setDisabled': { category: 'settings', risk: 'medium', targetParam: 'name' },
  'skill.create': { category: 'write', risk: 'medium', targetParam: 'name' },
  'skill.update': { category: 'write', risk: 'medium', targetParam: 'name' },
  'skill.templateList': { category: 'read', risk: 'low' },
  'skill.templateContent': { category: 'read', risk: 'low', targetParam: 'templateId' },
  'skill.inspectImport': { category: 'read', risk: 'medium', targetParam: 'folder' },
  'skill.import': { category: 'write', risk: 'medium', targetParam: 'folder' },
  'skill.delete': { category: 'write', risk: 'medium', targetParam: 'name' },
  'web.read': { category: 'network', risk: 'medium', targetParam: 'url' },
  'web.browser.status': { category: 'read', risk: 'low' },
  'web.browser.allowDomain': { category: 'settings', risk: 'medium', targetParam: 'domain' },
  'web.browser.removeDomain': { category: 'settings', risk: 'medium', targetParam: 'domain' },
  'web.browser.open': { category: 'network', risk: 'medium', targetParam: 'url' },
  'web.browser.clearProfile': { category: 'settings', risk: 'high' },
  'web.live.open': { category: 'network', risk: 'medium', targetParam: 'url' },
  'web.live.act': { category: 'network', risk: 'medium', targetParam: 'action' },
  'web.search': { category: 'network', risk: 'medium', targetParam: 'query' },
  'instruction.list': { category: 'read', risk: 'low' },
  'instruction.open': { category: 'write', risk: 'low', targetParam: 'origin' },
  'team.status': { category: 'read', risk: 'low' },
  'team.open': { category: 'read', risk: 'low' },
  'team.connect': { category: 'network', risk: 'medium', targetParam: 'repository' },
  'team.check': { category: 'network', risk: 'medium' },
  'team.update': { category: 'network', risk: 'medium' },
  'app.status': { category: 'read', risk: 'low' },
  'app.enable': { category: 'settings', risk: 'medium', targetParam: 'id' },
  'app.disable': { category: 'settings', risk: 'medium', targetParam: 'id' },
  'app.trust': { category: 'settings', risk: 'high', targetParam: 'id' },
  'app.templateList': { category: 'read', risk: 'low' },
  'app.templateContent': { category: 'read', risk: 'low', targetParam: 'templateId' },
}

export function getToolPolicy(name: string): ToolPolicy {
  return TOOL_POLICIES[name] ?? {
    category: 'general',
    risk: 'low',
    label: name,
  }
}

// Static TOOL_POLICIES always wins — core tools cannot be re-policied by an
// app. Then dynamic (app-registered), then the general/low default.
function resolveToolPolicy(
  name: string,
  getDynamic?: (toolName: string) => ToolPolicy | undefined,
): ToolPolicy {
  if (TOOL_POLICIES[name]) return TOOL_POLICIES[name]
  const dynamic = getDynamic?.(name)
  if (dynamic) return dynamic
  return { category: 'general', risk: 'low', label: name }
}

export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const pending = new Map<string, (decision: PermissionApprovalDecision) => void>()
  // Track which session each pending request belongs to, so cancelSession can
  // resolve them all as denied.
  const pendingSessionIndex = new Map<string, string>() // requestId -> sessionId
  const sessionToolAllows = new Set<string>()
  const record = options.recordDecision ?? (() => {})

  async function check(tool: ToolDef, params: Record<string, unknown>, ctx: ToolContext): Promise<void> {
    const mode = await options.getApprovalMode()
    const policy = resolveToolPolicy(tool.name, options.getDynamicToolPolicy)
    const redactedParams = redactPermissionParams(params) as Record<string, unknown>
    const pathInfo = getPathInfo(policy, params, options.getWorkspacePath())
    const target = getTarget(policy, params, pathInfo?.absolutePath ?? undefined)
    const routineContext = ctx.routine
    const subagentContext = ctx.subagent
    const baseEvent = {
      tool: tool.name,
      actor: ctx.actor,
      package_id: ctx.package_id,
      sessionId: ctx.sessionId,
      routineId: routineContext?.id,
      routineRunId: routineContext?.runId,
      subagentRootSessionId: subagentContext?.rootSessionId,
      subagentParentSessionId: subagentContext?.parentSessionId,
      subagentDepth: subagentContext?.depth,
      traceId: ctx.traceId,
      parentSpanId: ctx.spanId,
      category: policy.category,
      risk: policy.risk,
      mode,
      target,
      pathKind: pathInfo?.kind,
      params: redactedParams,
    }

    // The checkout symlink is infrastructure, not a file. Protect it before
    // every actor's allow path while leaving all Team contributions writable.
    if (policy.category === 'write') {
      const secondaryPathInfo = getSecondaryPathInfo(policy, params, options.getWorkspacePath())
      for (const info of [pathInfo, secondaryPathInfo]) {
        if (!info?.isTeamRoot) continue
        const reason = 'The Team checkout mount is managed by Mim'
        record({ ...baseEvent, pathKind: 'team', decision: 'denied', reason })
        throw new PermissionDeniedError(`Permission denied: ${reason}`)
      }
      for (const info of [pathInfo, secondaryPathInfo]) {
        if (info?.kind !== 'mim') continue
        const reason = 'Mim built-in documents are read-only'
        record({ ...baseEvent, pathKind: 'mim', decision: 'denied', reason })
        throw new PermissionDeniedError(`Permission denied: ${reason}`)
      }
    }

    if (
      tool.name === 'app.trust' &&
      ctx.actor !== 'user' &&
      ctx.actor !== 'system' &&
      ctx.actor !== 'package'
    ) {
      const reason = 'Trust acknowledgement is user-only'
      record({ ...baseEvent, decision: 'denied', reason })
      throw new PermissionDeniedError(`Permission denied: ${reason}`)
    }

    // Agent sessions are interactive ptys with the user's full shell
    // authority; AI already has terminal.run for command execution. Launch
    // and kill stay user-only in v1 (agent-sessions decision 4) — hard-denied
    // before any approval or developer-mode bypass, like app.trust.
    if ((tool.name === 'agent.launch' || tool.name === 'agent.stop') && ctx.actor !== 'user' && ctx.actor !== 'package') {
      const reason = 'Agent sessions are user-only'
      record({ ...baseEvent, decision: 'denied', reason })
      throw new PermissionDeniedError(`Permission denied: ${reason}`)
    }

    if (tool.name.startsWith('subagent.') && ctx.actor === 'package') {
      const reason = 'Apps cannot create or control subagents'
      record({ ...baseEvent, decision: 'denied', reason })
      throw new PermissionDeniedError(`Permission denied: ${reason}`)
    }

    if (
      ctx.actor === 'ai' &&
      subagentContext?.toolAllowlist &&
      !subagentContext.toolAllowlist.includes(tool.name)
    ) {
      const reason = `${tool.name} is outside the delegated tool surface`
      record({ ...baseEvent, decision: 'denied', reason })
      throw new PermissionDeniedError(`Permission denied: ${reason}`)
    }

    const requestedGrants = tool.name === 'subagent.spawn' && Array.isArray(params.requestedGrants)
      ? params.requestedGrants.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    if (subagentContext?.toolAllowlist) {
      const invalidGrant = requestedGrants.find(toolName => !subagentContext.toolAllowlist!.includes(toolName))
      if (invalidGrant) {
        const reason = `Requested grant is outside the delegated tool surface: ${invalidGrant}`
        record({ ...baseEvent, decision: 'denied', reason })
        throw new PermissionDeniedError(`Permission denied: ${reason}`)
      }
    }

    if (ctx.actor === 'user' || ctx.actor === 'system') {
      record({ ...baseEvent, decision: 'allowed', reason: 'direct user action' })
      return
    }

    if (ctx.actor === 'package') {
      if (pathInfo?.kind === 'personal' || pathInfo?.kind === 'mim') {
        const reason = `App ${ctx.package_id} cannot access Personal or Mim instruction and skill documents`
        record({ ...baseEvent, decision: 'denied', reason })
        throw new PermissionDeniedError(`Permission denied: ${reason}`)
      }
      const packageReason = packagePermissionViolation(tool.name, policy, params, ctx, options.getPackagePermissions)
      if (packageReason) {
        record({ ...baseEvent, decision: 'denied', reason: packageReason })
        throw new PermissionDeniedError(`Permission denied: ${packageReason}`)
      }
      if (policy.category === 'write' && pathInfo?.kind === 'sensitive') {
        const reason = `App ${ctx.package_id} cannot write to sensitive path`
        record({ ...baseEvent, decision: 'denied', reason })
        throw new PermissionDeniedError(`Permission denied: ${reason}`)
      }
      record({ ...baseEvent, decision: 'allowed', reason: 'app permission granted' })
      return
    }

    let savedBrowserSession: SavedBrowserSessionApproval | null = null
    if (ctx.actor === 'ai' && options.resolveSavedBrowserSessionGrant) {
      const resolved = options.resolveSavedBrowserSessionGrant(tool.name, params, ctx)
      savedBrowserSession = isPromiseLike(resolved) ? (await resolved) ?? null : resolved ?? null
    }

    const allowScopeId = subagentContext?.rootSessionId ?? ctx.sessionId
    const allowKey = allowScopeId ? `${allowScopeId}:${tool.name}` : null
    const reason = tool.name.startsWith('subagent.') && requestedGrants.length === 0 && mode === 'normal'
      ? null
      : approvalReason(tool.name, policy, mode, pathInfo?.kind, pathInfo?.reason)
    const pathFloorActive = pathInfo?.kind === 'sensitive' || pathInfo?.kind === 'outside-workspace'
    const needsSavedBrowserGrant = Boolean(savedBrowserSession && !savedBrowserSession.granted)

    const requestApproval = async (approvalRequestReason: string, opts: { allowSessionRemember: boolean }) => {
      const request: PermissionApprovalRequest = {
        requestId: randomUUID(),
        toolName: tool.name,
        actor: ctx.actor,
        package_id: ctx.package_id,
        sessionId: ctx.sessionId,
        routineId: routineContext?.id,
        routineRunId: routineContext?.runId,
        subagentRootSessionId: subagentContext?.rootSessionId,
        subagentParentSessionId: subagentContext?.parentSessionId,
        subagentDepth: subagentContext?.depth,
        category: policy.category,
        risk: policy.risk,
        mode,
        reason: approvalRequestReason,
        target,
        pathKind: pathInfo?.kind,
        label: policy.label,
        params: redactedParams,
        preview: buildApprovalPreview(tool.name, params),
        ...(savedBrowserSession ? { savedBrowserSession } : {}),
      }

      record({ ...baseEvent, decision: 'requested', reason: approvalRequestReason })
      if (options.onApprovalRequested) await options.onApprovalRequested(request)

      const sent = options.sendApprovalRequest(request)
      if (!sent) {
        const deniedReason = 'No approval surface available'
        await options.onApprovalResolved?.(request, { approved: false })
        record({ ...baseEvent, decision: 'denied', reason: deniedReason })
        throw new PermissionDeniedError(`Permission denied: ${deniedReason}`)
      }

      const decision = await new Promise<PermissionApprovalDecision>((resolveDecision) => {
        pending.set(request.requestId, resolveDecision)
        if (ctx.sessionId) pendingSessionIndex.set(request.requestId, ctx.sessionId)
      })
      await options.onApprovalResolved?.(request, decision)

      if (!decision.approved) {
        record({ ...baseEvent, decision: 'denied', reason: 'User denied approval' })
        throw new PermissionDeniedError(`Permission denied: ${tool.name}`)
      }

      if (allowKey && opts.allowSessionRemember && decision.alwaysAllow) {
        sessionToolAllows.add(allowKey)
      }
      if (allowScopeId) {
        for (const grantedTool of requestedGrants) sessionToolAllows.add(`${allowScopeId}:${grantedTool}`)
      }
      await grantSavedBrowserSessionIfNeeded(savedBrowserSession, params, ctx, options)
      record({ ...baseEvent, decision: 'approved', reason: approvalRequestReason })
    }

    if (ctx.actor === 'ai' && routineContext) {
      const granted = routineToolGranted(routineContext.approvalAllow ?? [], tool.name)
      const routineReason = routineApprovalReason({
        granted,
        toolName: tool.name,
        policy,
        pathInfo,
        pathFloorActive,
        needsSavedBrowserGrant,
        normalReason: approvalReason(tool.name, policy, 'normal', pathInfo?.kind, pathInfo?.reason),
      })
      if (!routineReason) {
        record({ ...baseEvent, decision: 'allowed', reason: granted ? 'routine approval grant' : 'routine baseline' })
        return
      }
      await requestApproval(routineReason, { allowSessionRemember: false })
      return
    }

    if (
      ctx.actor === 'ai' &&
      (subagentContext?.requestedGrants?.includes(tool.name) || subagentContext?.approvalAllow?.includes(tool.name)) &&
      !pathFloorActive &&
      !needsSavedBrowserGrant
    ) {
      record({ ...baseEvent, decision: 'allowed', reason: 'delegated task grant' })
      return
    }

    if (mode === 'developer') {
      await grantSavedBrowserSessionIfNeeded(savedBrowserSession, params, ctx, options)
      record({ ...baseEvent, decision: 'bypassed', reason: 'developer mode' })
      return
    }

    // Session "always allow" may short-circuit ONLY when the path floor does not
    // independently require a prompt. Sensitive and outside-workspace paths always
    // prompt — the floor promise from docs/security.md must never be suppressed.
    if (allowKey && sessionToolAllows.has(allowKey) && !pathFloorActive && !needsSavedBrowserGrant) {
      record({ ...baseEvent, decision: 'allowed', reason: 'allowed for this session' })
      return
    }
    if (!reason) {
      record({ ...baseEvent, decision: 'allowed', reason: 'policy allowed' })
      return
    }
    await requestApproval(reason, { allowSessionRemember: true })
  }

  return {
    check,
    respond(requestId, decision) {
      const resolveDecision = pending.get(requestId)
      if (!resolveDecision) return false
      pending.delete(requestId)
      pendingSessionIndex.delete(requestId)
      resolveDecision(decision)
      return true
    },
    cancelSession(sessionId) {
      // Resolve all pending approval requests for this session as denied.
      for (const [requestId, sid] of [...pendingSessionIndex]) {
        if (sid !== sessionId) continue
        const resolveDecision = pending.get(requestId)
        if (resolveDecision) {
          pending.delete(requestId)
          pendingSessionIndex.delete(requestId)
          resolveDecision({ approved: false })
        }
      }
      // Clear all session "always allow" entries for this session.
      for (const key of [...sessionToolAllows]) {
        if (key.startsWith(`${sessionId}:`)) sessionToolAllows.delete(key)
      }
    },
  }
}

function isPromiseLike<T>(value: T | Promise<T> | null | undefined): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === 'function')
}

async function grantSavedBrowserSessionIfNeeded(
  grant: SavedBrowserSessionApproval | null,
  params: Record<string, unknown>,
  ctx: ToolContext,
  options: PermissionGateOptions,
): Promise<void> {
  if (!grant || grant.granted) return
  await options.grantSavedBrowserSessionDomain?.(grant, params, ctx)
}

// Map a gate decision into the unified trace stream, parented under the tool
// call span being gated. Shared by the Electron and headless kernels.
export function traceGateDecision(trace: TraceLog, event: PermissionDecisionEvent): void {
  // Automatic allows duplicate the tool span without recording a meaningful
  // trust boundary. Keep only events where the gate was actually exercised.
  if (event.decision === 'allowed') return
  trace.append({
    kind: 'gate.decision',
    actor: event.actor,
    tool: event.tool,
    subject: event.target,
    sessionId: event.sessionId,
    ...(event.package_id ? { packageId: event.package_id } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
    data: {
      decision: event.decision,
      mode: event.mode,
      reason: event.reason,
      category: event.category,
      risk: event.risk,
      pathKind: event.pathKind,
      ...(event.routineId ? { routineId: event.routineId } : {}),
      ...(event.routineRunId ? { routineRunId: event.routineRunId } : {}),
      ...(event.subagentRootSessionId ? { subagentRootSessionId: event.subagentRootSessionId } : {}),
      ...(event.subagentParentSessionId ? { subagentParentSessionId: event.subagentParentSessionId } : {}),
      ...(event.subagentDepth !== undefined ? { subagentDepth: event.subagentDepth } : {}),
    },
  })
}

// Derive a "what will change" preview from the raw params of a file-mutating
// tool, so the UI can show a real diff before the user approves. Returns
// undefined for tools that have no reviewable change (terminal, sends, settings);
// those are judged from the action and target alone.
export function buildApprovalPreview(toolName: string, params: Record<string, unknown>): ApprovalPreview | undefined {
  if (toolName === 'fs.edit') {
    const oldText = typeof params.old_text === 'string' ? params.old_text : ''
    const newText = typeof params.new_text === 'string' ? params.new_text : ''
    return { kind: 'edit', oldText, newText }
  }
  if (toolName === 'fs.write') {
    return { kind: 'write', content: typeof params.content === 'string' ? params.content : '' }
  }
  if (toolName === 'fs.create') {
    return { kind: 'create', content: typeof params.content === 'string' ? params.content : '' }
  }
  if (toolName === 'fs.delete') {
    return { kind: 'delete' }
  }
  return undefined
}

export function redactPermissionParams(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPermissionParams)
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactKey(key)) {
      out[key] = '[redacted]'
    } else {
      out[key] = redactPermissionParams(child)
    }
  }
  return out
}

function shouldRedactKey(key: string): boolean {
  return /content|key|token|password|secret/i.test(key)
}

function getPathInfo(policy: ToolPolicy, params: Record<string, unknown>, workspacePath: string | null) {
  if (!policy.pathParam) return null
  const value = params[policy.pathParam]
  if (typeof value !== 'string') return null
  return classifyPermissionPath(value, workspacePath)
}

function getSecondaryPathInfo(policy: ToolPolicy, params: Record<string, unknown>, workspacePath: string | null) {
  if (!policy.secondaryPathParam) return null
  const value = params[policy.secondaryPathParam]
  if (typeof value !== 'string') return null
  return classifyPermissionPath(value, workspacePath)
}

function getTarget(policy: ToolPolicy, params: Record<string, unknown>, pathTarget?: string): string | undefined {
  if (pathTarget) return pathTarget
  if (!policy.targetParam) return undefined
  const value = params[policy.targetParam]
  if (value == null) return undefined
  return String(value).slice(0, 500)
}

// What an action does, which is what the prompt decision keys off — not its risk
// tier. Risk is now purely cosmetic (the card's caution styling). 'read' is local
// and side-effect-free; 'mutate' changes data or state; 'external' contacts a
// third-party service.
export type ToolEffect = 'read' | 'mutate' | 'external'

// Tools whose effect their category bucket gets wrong: local reads filed under a
// mutating bucket, navigation filed under 'ui', benign internal writes (an
// idempotent regen, an append to the runtime log), and a secrets-flow helper that
// actually calls out. 'read' here means "no prompt in Normal, still prompt in
// Strict" — so it doubles as the exemption tag for benign mutations. Everything
// else derives from the category, and any unmapped tool falls through to 'mutate'.
const EFFECT_OVERRIDES: Record<string, ToolEffect> = {
  'settings.get': 'read',
  'toolPolicy.get': 'read',
  'telemetry.track': 'read',
  'terminal.resize': 'read',
  'editor.open': 'read',
  'workbench.openWork': 'read',
  'workbench.openArtifact': 'read',
  'workspace.orient': 'read',
  'history.baseline': 'read',
  'history.openVersion': 'read',
  'sync.status': 'read',
  'log.append': 'read',
  'slack.status': 'read',
  'slack.bot.status': 'read',
  'slack.bot.check': 'read',
  'slack.listener.status': 'read',
  'google.status': 'read',
  'google.authUrl': 'read',
  'google.exchangeCode': 'external',
}

function categoryEffect(category: ToolCategory): ToolEffect {
  switch (category) {
    case 'read':
    case 'search':
    case 'ai':
      return 'read'
    case 'network':
      return 'external'
    default:
      // write, secrets, system, settings, ui, general — and any unknown tool
      // (which defaults to the 'general' policy) — count as mutations.
      return 'mutate'
  }
}

// Resolve the effect for a tool given its already-resolved policy.
function resolvedToolEffect(name: string, policy: ToolPolicy): ToolEffect {
  return EFFECT_OVERRIDES[name] ?? categoryEffect(policy.category)
}

export function toolEffect(name: string): ToolEffect {
  return resolvedToolEffect(name, getToolPolicy(name))
}

// Three modes, one rule each:
//   strict   — every action needs a yes.
//   normal   — anything that changes data or talks to an outside service.
//   allow-all (developer) — never reaches here; bypassed earlier in check().
// A sensitive or outside-workspace path is a floor under strict and normal: it
// always prompts, whatever the tool does.
function approvalReason(
  toolName: string,
  policy: ToolPolicy,
  mode: ApprovalMode,
  pathKind?: PermissionPathKind,
  pathReason?: string,
): string | null {
  if (pathKind === 'sensitive' || pathKind === 'outside-workspace') {
    return pathReason ?? 'Path needs approval'
  }
  if (pathKind === 'team' && resolvedToolEffect(toolName, policy) === 'mutate') {
    return 'Team file write requires approval'
  }
  if (mode === 'strict') {
    return 'Strict mode: every action needs approval'
  }
  const effect = resolvedToolEffect(toolName, policy)
  if (effect === 'mutate') return 'This changes your workspace'
  if (effect === 'external') return 'This contacts an outside service'
  return null
}

function routineToolGranted(grants: string[], toolName: string): boolean {
  return grants.includes(toolName)
}

function routineApprovalReason(input: {
  granted: boolean
  toolName: string
  policy: ToolPolicy
  pathInfo: PermissionPathClassification | null
  pathFloorActive: boolean
  needsSavedBrowserGrant: boolean
  normalReason: string | null
}): string | null {
  if (input.granted) {
    if (input.pathFloorActive || input.needsSavedBrowserGrant) {
      return input.normalReason ?? 'Routine path needs approval'
    }
    if (input.pathInfo?.kind === 'team' && resolvedToolEffect(input.toolName, input.policy) === 'mutate') {
      return input.normalReason ?? 'Team file write requires approval'
    }
    return null
  }

  if (
    resolvedToolEffect(input.toolName, input.policy) === 'read' &&
    !input.pathFloorActive &&
    !input.needsSavedBrowserGrant
  ) {
    return null
  }
  return 'Routine needs approval for this tool'
}

function packagePermissionViolation(
  toolName: string,
  policy: ToolPolicy,
  params: Record<string, unknown>,
  ctx: ToolContext,
  getPackagePermissions?: (packageId: string) => PackagePermissions | undefined,
): string | null {
  if (ctx.actor !== 'package') return null
  if (!ctx.package_id) return 'App tool call is missing app identity'
  if (!getPackagePermissions) return null

  const permissions = getPackagePermissions(ctx.package_id)
  if (!permissions) return `App ${ctx.package_id} is not installed or enabled`

  if (policy.ownerPackageId && policy.ownerPackageId !== ctx.package_id) {
    return `App ${ctx.package_id} cannot call tools owned by app ${policy.ownerPackageId}`
  }

  if (
    toolName === 'package.create' ||
    toolName === 'package.edit' ||
    toolName === 'package.delete' ||
    toolName === 'package.reload'
  ) {
    return `App ${ctx.package_id} cannot manage app installation or enablement`
  }

  if (toolName === 'app.enable' || toolName === 'app.disable') {
    if (params.id === ctx.package_id) return null
    return `App ${ctx.package_id} cannot manage enablement of other apps`
  }
  if (toolName === 'app.trust') {
    return `App ${ctx.package_id} cannot acknowledge app trust`
  }
  if (toolName === 'app.templateList' || toolName === 'app.templateContent') {
    return `App ${ctx.package_id} cannot access app starter templates`
  }

  // The whole agent.* surface (catalog, launch/kill, session records and
  // scrollback) is off-limits to apps — agent sessions run with the
  // user's full shell authority.
  if (toolName.startsWith('agent.')) {
    return `App ${ctx.package_id} cannot access agent sessions`
  }

  if (toolName.startsWith('git.') || toolName.startsWith('sync.')) {
    return `App ${ctx.package_id} cannot access workspace git or sync tools`
  }

  if (toolName.startsWith('team.')) {
    return `App ${ctx.package_id} cannot access the Personal Team connection or checkout`
  }

  if (policy.category === 'system') {
    return `App ${ctx.package_id} cannot use system tools in runtime v1`
  }

  if (toolName.startsWith('settings.')) {
    return `App ${ctx.package_id} cannot access workspace settings`
  }

  if (toolName === 'config.get') {
    return `App ${ctx.package_id} cannot access Personal config`
  }

  if (toolName.startsWith('session.')) {
    return `App ${ctx.package_id} cannot access chat session storage`
  }

  // App secret tools are scoped to the manifest's declared secret names,
  // mirroring how ctx.secrets is scoped in the app runtime.
  if (toolName.startsWith('package.secrets.')) {
    const declared = permissions.secrets ?? []
    if (declared.length === 0) return `App ${ctx.package_id} did not declare any secrets`
    // Only `status` is name-less; set/delete must name a declared secret here,
    // so the gate never records 'allowed' for a call it did not validate.
    if (toolName !== 'package.secrets.status') {
      const name = typeof params.name === 'string' ? params.name : ''
      if (name.length === 0) return `App secret tools require a declared secret name`
      if (!declared.includes(name)) return `App ${ctx.package_id} did not declare secret: ${name}`
    }
    return null
  }

  if (toolName.startsWith('skill.') || toolName.startsWith('instruction.')) {
    return `App ${ctx.package_id} cannot access AI skill activation state`
  }

  if (toolName === 'ai.setKey') {
    return `App ${ctx.package_id} cannot access provider keys directly`
  }

  if (toolName.startsWith('slack.')) {
    return `App ${ctx.package_id} cannot access personal Slack integrations in runtime v1`
  }

  if (toolName.startsWith('web.')) {
    return `App ${ctx.package_id} cannot access web reader tools in runtime v1; use ctx.http with declared host permissions`
  }

  if (toolName.startsWith('google.') || toolName.startsWith('gmail.') || toolName.startsWith('calendar.') || toolName.startsWith('drive.') || toolName.startsWith('docs.') || toolName.startsWith('sheets.')) {
    return `App ${ctx.package_id} cannot access personal Google integrations in runtime v1`
  }

  if (toolName === 'documents.pickReviewFile' && permissions.workspace?.write !== true) {
    return `App ${ctx.package_id} did not declare workspace write permission`
  }

  if (toolName === 'documents.pickImportFile' && permissions.workspace?.write !== true) {
    return `App ${ctx.package_id} did not declare workspace write permission`
  }

  if (toolName === 'documents.importMarkdown' && (permissions.workspace?.read !== true || permissions.workspace?.write !== true)) {
    return `App ${ctx.package_id} must declare workspace read and write permission`
  }

  if (toolName === 'references.setBibliographyPath' && permissions.workspace?.read !== true) {
    return `App ${ctx.package_id} did not declare workspace read permission`
  }

  if (toolName.startsWith('terminal.')) {
    return `App ${ctx.package_id} cannot run terminal commands in runtime v1`
  }

  if (policy.pathParam && policy.category === 'read' && permissions.workspace?.read !== true) {
    return `App ${ctx.package_id} did not declare workspace read permission`
  }

  if (policy.pathParam && policy.category === 'write' && permissions.workspace?.write !== true) {
    return `App ${ctx.package_id} did not declare workspace write permission`
  }

  if (toolName === 'search.sessions' || (toolName === 'search' && params.scope !== 'files')) {
    return `App ${ctx.package_id} cannot access chat session search`
  }

  if ((toolName === 'search.files' || toolName === 'search') && permissions.workspace?.read !== true) {
    return `App ${ctx.package_id} did not declare workspace read permission`
  }

  if (policy.category === 'ai' && permissions.ai !== true) {
    return `App ${ctx.package_id} did not declare AI permission`
  }

  return null
}
