import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { Buffer } from 'buffer'
import { randomUUID } from 'crypto'
import {
  convertToModelMessages,
  generateObject,
  jsonSchema,
  stepCountIs,
  tool,
  ToolLoopAgent,
  validateUIMessages,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import { loadRegistry, resolveKey } from '@main/ai/ai.js'
import { buildGoogleAiTools } from '@main/integrations/google/aiTools.js'
import { readGooglePolicy, type GoogleConnectorPolicy } from '@main/integrations/google/policy.js'
import { buildSlackAiTools } from '@main/integrations/slack/aiTools.js'
import { readSlackPolicy } from '@main/integrations/slack/policy.js'
import { buildProviderOptions, type ModelConfig } from '@main/ai/providerOptions.js'
import { formatSkillCatalogSection, getSystemPrompt } from '@main/ai/systemPrompt.js'
import {
  buildModelContext,
  selectCompactionCut,
  estimateMessagesTokens,
  type ContextCompactionRecord,
} from '@main/ai/compaction.js'
import { appendSessionCompaction } from '@main/sessions.js'
import type { SubagentSessionMetadata } from '@main/subagents/types.js'
import { loadRoutineCatalog, type RoutineDefinition } from '@main/routines/routines.js'
import type { SkillLoader } from '@main/skills.js'
import type { ToolContext, ToolRegistry } from '@main/tools/registry.js'
import {
  aiToolKeyEnabled,
  readToolsPolicy,
  registryToolEnabled,
  type EffectiveToolPolicy,
} from '@main/tools/toolPolicy.js'
import { newSpanId, newTraceId } from '@main/trace/trace.js'

export { repairIncompleteToolMessages } from '@main/ai/compaction.js'

export type AiProfile = 'chat' | 'inline' | 'ghost'

interface ModelRegistry {
  providers?: Record<string, { url: string; apiKeyEnv: string }>
  defaults?: Record<string, string[]>
  models?: ModelConfig[]
}

interface PackageToolSummary {
  name: string
  id?: string
  packageId?: string
  packageName?: string
  label?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface ActivatedSkill {
  name: string
  description?: string
  body?: string
  revision?: string
  tools: string[]
  unlocks: string[]
}

export interface SkillCatalogSummary {
  id?: string
  name: string
  description: string
  tools: string[]
  unlocks: string[]
  packageName?: string
}

interface AiRuntimeOptions {
  tools: ToolRegistry
  agentMounts?: { resolveProfile(agentId: string): Promise<AgentProfile> }
}

export interface StreamRequest {
  id?: string
  messages: UIMessage[]
  modelId?: string
  controlId?: string
  skills?: string[]
  agentId?: string
  selection?: {
    text?: string
    contextBefore?: string
    contextAfter?: string
  }
  routine?: ToolContext['routine']
  trace?: { traceId: string; spanId: string }
  abortSignal?: AbortSignal
  // Trusted runtime context for a delegated thread. This is created by the
  // subagent manager, never accepted directly from model-authored input.
  subagent?: ToolContext['subagent']
  // Durable steering messages are consumed between model steps. The runtime
  // persists any messages it injects into the completed session transcript.
  consumeSubagentInbox?: () => Promise<UIMessage[]>
  onSubagentActivity?: (activity: string) => void | Promise<void>
}

export interface AgentProfile {
  id: string
  toolSurface: 'chat' | 'inline'
  modelFeature: string
  defaultModelId?: string
  buildInstructions(input: {
    workspacePath: string | undefined
    skillCatalog: SkillCatalogSummary[]
    selectedSkillsSection: string | null
    request: StreamRequest
    trace?: { traceId: string; spanId: string }
  }): string | Promise<string>
  useCatalogs: boolean
  persistSession: boolean
  stepCap: number
  maxOutputTokens?: number
  temperature?: number
  sendReasoning: boolean
  toolAllowlist?: string[]
  preActivatedSkills?: string[]
}

export const chatProfile: AgentProfile = {
  id: 'chat',
  toolSurface: 'chat',
  modelFeature: 'chat',
  useCatalogs: true,
  persistSession: true,
  stepCap: 100,
  sendReasoning: true,
  buildInstructions({ workspacePath, skillCatalog, selectedSkillsSection }) {
    return [
      getSystemPrompt(workspacePath, {
        skillCatalog: formatSkillCatalogSection(skillCatalog) ?? undefined,
      }),
      selectedSkillsSection,
    ].filter(Boolean).join('\n\n\n')
  },
}

export const inlineProfile: AgentProfile = {
  id: 'inline',
  toolSurface: 'inline',
  modelFeature: 'inline',
  useCatalogs: false,
  persistSession: false,
  stepCap: 4,
  maxOutputTokens: 2000,
  temperature: 0.3,
  sendReasoning: false,
  buildInstructions({ request }) {
    return buildInlineSystemPrompt(request.selection || {})
  },
}

interface GhostRequest {
  before: string
  after: string
  fallback?: string[]
  modelId?: string
}

interface TaskLabelRequest {
  userText: string
  contextLabels?: string[]
  modelId?: string
}

interface SummaryRequest {
  messages: Array<{ role: string; content?: string; parts?: Array<Record<string, unknown>> }>
  modelId?: string
}

export const MAX_TOOL_OUTPUT_CHARS = 24000
export const DEFAULT_AI_TOOL_TIMEOUT_MS = 5 * 60_000
const WEB_READ_TOOL_DEFAULT_TIMEOUT_MS = 45_000
const WEB_READ_TOOL_TIMEOUT_BUFFER_MS = 15_000
const WEB_READ_TOOL_MAX_TIMEOUT_MS = 180_000
const MAX_TASK_LABEL_CHARS = 40
const MAX_TASK_LABEL_WORDS = 4
// Anthropic tool names must match [A-Za-z0-9_-]+; normalize dotted/other names for SDK keys
export function aiToolKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

// SDK keys whose canonical registry tool id does not sanitize to the key
// mechanically. Every static tool in createAiSdkTools was verified; these are
// the only four mismatches. Composite SDK tools with no single canonical id
// (connections_status, connections_configure, skill, suggest_edit,
// package_tools_execute, ...) are intentionally NOT reachable via allowlist in v1.
const CANONICAL_TO_AI_KEY_EXCEPTIONS: Record<string, string> = {
  'shell.run': 'bash',
  'web.live.open': 'browser_open',
  'web.live.act': 'browser_act',
  'google.setOAuthClient': 'google_set_oauth_client',
}

/**
 * Map a canonical registry tool id to its AI SDK key. Uses the exceptions
 * table for the handful of tools whose SDK key was chosen for UX reasons
 * rather than mechanical sanitization; falls back to aiToolKey.
 */
export function canonicalToolIdToAiKey(id: string): string {
  return CANONICAL_TO_AI_KEY_EXCEPTIONS[id] ?? aiToolKey(id)
}

const contextDataSchema = z.object({
  filename: z.string(),
  mediaType: z.string().optional(),
  content: z.string(),
  size: z.number().optional(),
}).passthrough()

type MimContextData = z.infer<typeof contextDataSchema>

const looseObjectSchema = z.object({}).catchall(z.unknown())
const packageViewInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  src: z.string(),
  role: z.enum(['work', 'artifact', 'either']),
})
const packageSkillInputSchema = z.object({
  name: z.string(),
  content: z.string(),
})
const packageCreateInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  html: z.string().optional(),
  js: z.string().optional(),
  backend: z.string().optional(),
  skill: z.union([z.string(), packageSkillInputSchema]).optional(),
  skills: z.array(packageSkillInputSchema).optional(),
  readme: z.string().optional(),
  permissions: looseObjectSchema.optional(),
  provides: looseObjectSchema.optional(),
  dataFolder: z.string().optional(),
  views: z.array(packageViewInputSchema).optional(),
  override: z.boolean().optional(),
})

export function createAiRuntime({ tools, agentMounts }: AiRuntimeOptions) {
  return {
    streamChatResponse: async (request: StreamRequest) => {
      const subagentRequest = await resolveSubagentChatRequest(tools, request, agentMounts)
      if (subagentRequest) {
        return streamProfileResponse({ profile: subagentRequest.profile, tools, request: subagentRequest.request })
      }
      const routineRequest = await resolveActiveRoutineChatRequest(tools, request, agentMounts)
      if (routineRequest) {
        return streamProfileResponse({ profile: routineRequest.profile, tools, request: routineRequest.request })
      }
      let profile: AgentProfile = chatProfile
      if (request.agentId) {
        if (!agentMounts) throw new Error('Agent chat is not available')
        profile = await agentMounts.resolveProfile(request.agentId)
      }
      return streamProfileResponse({ profile, tools, request })
    },
    streamInlineResponse: (request: StreamRequest) =>
      streamProfileResponse({ profile: inlineProfile, tools, request }),
    generateGhostSuggestions: (request: GhostRequest) =>
      generateGhostSuggestions({ tools, request }),
    generateTaskLabel: (request: TaskLabelRequest) =>
      generateTaskLabel({ tools, request }),
    generateSummary: (request: SummaryRequest) =>
      generateSummary({ tools, request }),
  }
}

async function resolveSubagentChatRequest(
  tools: ToolRegistry,
  request: StreamRequest,
  agentMounts: AiRuntimeOptions['agentMounts'],
): Promise<{ profile: AgentProfile; request: StreamRequest } | null> {
  if (!request.id) return null
  const session = await tools.call('session.get', { id: request.id }, { actor: 'system' }).catch(() => null) as {
    agentId?: string
    messages?: UIMessage[]
    subagent?: SubagentSessionMetadata
  } | null
  const metadata = session?.subagent
  if (!metadata) return null

  const base = metadata.agentId
    ? await requireAgentMountsForSubagent(agentMounts).resolveProfile(metadata.agentId)
    : chatProfile
  const profile: AgentProfile = {
    ...base,
    id: `subagent:${request.id}`,
    defaultModelId: metadata.modelId ?? base.defaultModelId,
    persistSession: true,
    toolAllowlist: intersectToolAllowlists(base.toolAllowlist, metadata.effectiveToolAllowlist),
  }
  const storedMessages = Array.isArray(session?.messages) ? session.messages : []
  return {
    profile,
    request: {
      ...request,
      messages: mergeDurableThreadMessages(storedMessages, request.messages),
      modelId: metadata.modelId ?? profile.defaultModelId,
      agentId: metadata.agentId,
      subagent: subagentDelegationContext(metadata),
    },
  }
}

function requireAgentMountsForSubagent(agentMounts: AiRuntimeOptions['agentMounts']) {
  if (!agentMounts) throw new Error('Subagent profile support is not available')
  return agentMounts
}

function intersectToolAllowlists(
  profileAllowlist: string[] | undefined,
  delegatedAllowlist: string[] | undefined,
): string[] | undefined {
  if (!profileAllowlist) return delegatedAllowlist ? [...delegatedAllowlist] : undefined
  if (!delegatedAllowlist) return [...profileAllowlist]
  const profileTools = new Set(profileAllowlist)
  return delegatedAllowlist.filter(toolName => profileTools.has(toolName))
}

function mergeDurableThreadMessages(stored: UIMessage[], requested: UIMessage[]): UIMessage[] {
  if (!stored.length) return requested
  if (!requested.length) return stored
  const storedIds = new Set(stored.map(message => message.id))
  return [...stored, ...requested.filter(message => !storedIds.has(message.id))]
}

function subagentDelegationContext(metadata: SubagentSessionMetadata): NonNullable<ToolContext['subagent']> {
  return {
    rootSessionId: metadata.rootSessionId,
    parentSessionId: metadata.parentSessionId,
    depth: metadata.depth,
    modelId: metadata.modelId,
    profileId: metadata.agentId ?? 'chat',
    toolAllowlist: metadata.effectiveToolAllowlist,
    approvalAllow: metadata.approvalAllow,
    requestedGrants: metadata.requestedGrants,
    originActor: metadata.originActor ?? 'ai',
    status: metadata.status,
  }
}

async function resolveActiveRoutineChatRequest(
  tools: ToolRegistry,
  request: StreamRequest,
  agentMounts: AiRuntimeOptions['agentMounts'],
): Promise<{ profile: AgentProfile; request: StreamRequest } | null> {
  if (!request.id) return null
  const session = await tools.call('session.get', { id: request.id }, { actor: 'system' }).catch(() => null) as {
    routineId?: string
    routineRunId?: string
    routineStatus?: string
    messages?: UIMessage[]
  } | null
  if (!session?.routineId || !session.routineRunId) return null
  if (session.routineStatus !== 'working' && session.routineStatus !== 'needs-approval') return null

  const workspacePath = tools.getWorkspacePath()
  if (!workspacePath) throw new Error('No workspace open')
  const catalog = loadRoutineCatalog(workspacePath, {
    knownTools: new Set(tools.list().map(toolDef => toolDef.name)),
  })
  const routine = catalog.routines.find(item => item.id === session.routineId || item.name === session.routineId)
  if (!routine) {
    const diagnostic = catalog.diagnostics.find(item => item.routineId === session.routineId)
    throw new Error(diagnostic?.message ?? `Routine not found: ${session.routineId}`)
  }

  const profile = await resolveRoutineProfileForChat(routine, agentMounts)
  const messages = Array.isArray(session.messages) && session.messages.length
    ? session.messages
    : request.messages
  return {
    profile,
    request: {
      ...request,
      messages,
      modelId: routine.model ?? profile.defaultModelId,
      agentId: routine.agent,
      routine: {
        id: routine.id,
        runId: session.routineRunId,
        approvalAllow: routine.approvalAllow,
      },
    },
  }
}

async function resolveRoutineProfileForChat(
  routine: RoutineDefinition,
  agentMounts: AiRuntimeOptions['agentMounts'],
): Promise<AgentProfile> {
  const base = routine.agent
    ? await requireAgentMountsForRoutine(agentMounts).resolveProfile(routine.agent)
    : chatProfile
  return {
    ...base,
    id: `routine:${routine.id}`,
    defaultModelId: routine.model ?? base.defaultModelId,
    stepCap: routine.steps ?? base.stepCap,
    toolAllowlist: routineToolAllowlist(base.toolAllowlist, routine.tools),
  }
}

function requireAgentMountsForRoutine(agentMounts: AiRuntimeOptions['agentMounts']) {
  if (!agentMounts) throw new Error('Routine agent support is not available')
  return agentMounts
}

function routineToolAllowlist(baseAllowlist: string[] | undefined, routineTools: string[]): string[] | undefined {
  if (!routineTools.length) return baseAllowlist ? [...baseAllowlist] : undefined
  if (!baseAllowlist) return [...routineTools]
  const base = new Set(baseAllowlist)
  return routineTools.filter(toolName => base.has(toolName))
}

export async function createAiSdkTools({
  tools,
  profile,
  sessionId,
  packageTools = [],
  onSkillActivated,
  routine,
  subagent,
  trace,
}: {
  tools: ToolRegistry
  profile: AiProfile
  sessionId?: string
  packageTools?: PackageToolSummary[]
  onSkillActivated?: (skill: ActivatedSkill) => void
  routine?: ToolContext['routine']
  subagent?: ToolContext['subagent']
  // Trace context of the chat turn, so every tool call this agent makes
  // nests under the turn span in the trace stream.
  trace?: { traceId: string; spanId: string }
}) {
  if (profile === 'ghost') return {}

  const ctx = {
    actor: 'ai' as const,
    ...(sessionId ? { sessionId } : {}),
    ...(routine ? { routine } : {}),
    ...(subagent ? { subagent } : {}),
    ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
  }
  const call = (name: string, params: Record<string, unknown> = {}) => {
    return withAiToolTimeout(
      tools.call(name, params, ctx),
      aiToolTimeoutMs(name, params),
      name,
    )
  }
  const toolPolicy = readToolsPolicy(tools.getWorkspacePath(), {
    knownToolIds: packageTools.map(packageTool => packageTool.name),
  })

  const readTools = {
    fs_read: tool({
      description: 'Returns total_lines, total_chars, and truncated. Use start_line/limit for large files.',
      inputSchema: z.object({
        path: z.string(),
        start_line: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        max_chars: z.number().int().positive().optional(),
      }),
      execute: async (params) => call('fs.read', {
        ...params,
        max_chars: params.max_chars ?? MAX_TOOL_OUTPUT_CHARS,
      }),
    }),

    search: tool({
      description: 'Search workspace files and/or session history. scope: "files", "sessions", or "all" (default).',
      inputSchema: z.object({
        query: z.string(),
        scope: z.enum(['files', 'sessions', 'all']).optional(),
        file_pattern: z.string().optional(),
        max_results: z.number().optional(),
      }),
      execute: async (params) => call('search', params),
    }),

    web_read: tool({
      description: 'Read a URL and return cleaned markdown content. Selectable PDFs use local text extraction; ordinary web pages are rendered in Chromium so JavaScript-hydrated content is captured. Set stateful=true only when the user has approved website access for login, consent, or normal site state; it is not a general fix for timeouts or extraction failures.',
      inputSchema: z.object({
        url: z.string().url(),
        stateful: z.boolean().optional().describe('Use approved website access for granted domains'),
        max_chars: z.number().int().positive().optional().describe('Target maximum characters for the returned chunk (default 100000)'),
        start_from_char: z.number().int().nonnegative().optional().describe('Continue reading from this character offset when a prior result was truncated'),
        extract_links: z.boolean().optional().describe('Preserve link URLs in Markdown'),
        extract_images: z.boolean().optional().describe('Preserve image URLs in Markdown'),
        timeout_ms: z.number().int().positive().optional().describe('Render/fetch timeout in milliseconds (default 30000)'),
      }),
      execute: async (params) => call('web.read', params),
    }),

    web_search: tool({
      description: 'Search the web via Exa and return results with title, URL, and snippet. Requires an Exa API key (Settings → Models → Integrations). Use web_read to fetch full content from interesting results.',
      inputSchema: z.object({
        query: z.string().min(1),
        max_results: z.number().int().positive().max(20).optional().describe('Maximum results (default 10)'),
      }),
      execute: async (params) => call('web.search', params),
    }),
  }

  const liveBrowserTools = {
    browser_open: tool({
      description: 'Open Mim\'s Markanywhere-style live browser for interactive websites or localhost development servers. Returns one bounded observation field plus compact short actionable refs.',
      inputSchema: z.object({
        url: z.string().url(),
        stateful: z.boolean().optional().describe('Use approved Website Access profile for granted domains'),
        visible: z.boolean().optional().describe('Show the AI-controlled browser window so the user can watch or interact'),
        timeout_ms: z.number().int().positive().optional().describe('Navigation/capture timeout in milliseconds'),
        max_chars: z.number().int().positive().optional().describe('Maximum characters in the returned observation (default 100000)'),
        start_from_char: z.number().int().nonnegative().optional().describe('Continue the returned observation from this character offset in the cleaned page text'),
      }),
      execute: async (params) => call('web.live.open', params),
    }),

    browser_act: tool({
      description: 'Run a live browser action after browser_open. Actions: observe, click, type, scroll, wait, extract, show, hide, close. Observations return Markanywhere refs valid only until the next observation.',
      inputSchema: z.object({
        action: z.enum(['observe', 'click', 'type', 'scroll', 'wait', 'extract', 'show', 'hide', 'close']),
        ref: z.string().min(1).optional().describe('Required for click/type; ref from the latest observation'),
        text: z.string().optional().describe('Required for type'),
        direction: z.enum(['down', 'up', 'left', 'right']).optional().describe('Scroll direction'),
        amount: z.number().int().positive().optional().describe('Scroll amount in pixels'),
        ms: z.number().int().positive().optional().describe('Wait duration for action=wait'),
        wait_ms: z.number().int().positive().optional().describe('Post-action wait before the returned observation for click/type/scroll'),
        max_chars: z.number().int().positive().optional().describe('Maximum characters in the returned observation (default 100000)'),
        start_from_char: z.number().int().nonnegative().optional().describe('Continue returned observation from this character offset in the cleaned page text'),
      }),
      execute: async (params) => call('web.live.act', params),
    }),
  }

  const googlePolicy = readGooglePolicy(tools.getWorkspacePath())
  const googleTools = buildGoogleAiTools(call, await resolveGoogleAiToolState(call, googlePolicy))

  if (profile === 'inline') {
    return filterAiToolMap({
      ...readTools,
      ...googleTools,
      suggest_edit: tool({
        description: 'Suggest replacement text for the selected text.',
        inputSchema: z.object({
          replacement: z.string().describe('The full replacement text for the selection'),
        }),
          execute: async ({ replacement }) => ({ replacement }),
        }),
    }, toolPolicy)
  }

  const dynamicPackageTools: Record<string, ReturnType<typeof tool>> = {}
  for (const packageTool of packageTools) {
    if (!registryToolEnabled(toolPolicy, packageTool.name)) continue
    const key = aiToolKey(packageTool.name)
    // execute uses the ORIGINAL name so the package runtime resolves it
    const originalName = packageTool.name
    dynamicPackageTools[key] = tool({
      description: `${packageTool.description || packageTool.label || packageTool.name} Provided by ${packageTool.packageName || packageTool.packageId || 'package'}.`,
      inputSchema: jsonSchema(packageTool.inputSchema || { type: 'object', properties: {} }),
      // Named granted tools are registered in the ToolRegistry under their
      // public name (namedPackageTools sync) with their own per-tool gate
      // policy, and scoped package agents list those names in the delegated
      // toolAllowlist. Dispatching by the real name lets the gate check the
      // name the profile actually granted; routing through
      // package.tools.execute would be denied as outside the delegated
      // surface and would flatten every tool to the blanket general/low
      // policy. Un-named chat-audience tools have no individual registration,
      // so they keep the package.tools.execute path (checked per call: the
      // named-tool sync re-registers on package reload).
      execute: async (input) => tools.get(originalName)
        ? call(originalName, (input ?? {}) as Record<string, unknown>)
        : call('package.tools.execute', { name: originalName, input }),
    })
  }

  const skillTools = {
    skill: tool({
      description: 'Activate a skill by authored name or package-qualified id when the user request matches its catalog description. Returns the skill instructions and unlocks its declared tools for this run.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const result = await call('skill.get', { name }) as { skill?: unknown }
        const skill = normalizeActivatedSkill(result.skill)
        onSkillActivated?.(skill)
        return { skill }
      },
    }),

    skill_create: tool({
      description: 'Create one Personal skill from a complete SKILL.md document. The name in the document frontmatter must match name.',
      inputSchema: z.object({
        name: z.string().min(1),
        content: z.string().min(1).describe('Complete SKILL.md including YAML frontmatter'),
      }),
      execute: async ({ name, content }) => call('skill.create', {
        name,
        content,
        destination: 'personal',
      }),
    }),

    skill_update: tool({
      description: 'Replace one Personal skill from a complete SKILL.md document, guarded by the revision returned when the skill was activated.',
      inputSchema: z.object({
        name: z.string().min(1),
        expectedRevision: z.string().min(1),
        content: z.string().min(1).describe('Complete replacement SKILL.md including YAML frontmatter'),
      }),
      execute: async ({ name, expectedRevision, content }) => call('skill.update', {
        name,
        expectedRevision,
        content,
      }),
    }),
  }

  // Security property: static tools win over dynamic package tools. A package cannot
  // shadow a core SDK tool (e.g. fs_write) by registering a tool with the same sanitized key.
  const slackPolicy = readSlackPolicy(tools.getWorkspacePath())
  const slackTools = buildSlackAiTools(call, slackPolicy)

  const staticTools = {
    ...readTools,
    ...liveBrowserTools,
    ...googleTools,
    ...slackTools,
    ...skillTools,

    subagent_spawn: tool({
      description: 'Create a durable child agent thread for a bounded task. Returns immediately; use subagent_wait when you need its result. Children may run for minutes or hours.',
      inputSchema: z.object({
        prompt: z.string().min(1),
        label: z.string().optional(),
        model: z.string().optional(),
        agent: z.string().optional(),
        skills: z.array(z.string()).optional(),
        tools: z.array(z.string()).optional().describe('Optional narrowing of the inherited tool surface'),
        context: z.array(z.string()).optional().describe('Workspace text files to attach to the first turn'),
        requestedGrants: z.array(z.string()).optional().describe('Tool grants to request from the permission gate; this never grants authority directly'),
      }),
      execute: async (params) => call('subagent.spawn', params),
    }),

    subagent_wait: tool({
      description: 'Event-driven wait for one or more children. timeoutMs only bounds this long-poll and never stops a child.',
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        until: z.enum(['any', 'all']).optional(),
        timeoutMs: z.number().int().min(0).max(240_000).optional(),
      }),
      execute: async (params) => call('subagent.wait', params),
    }),

    subagent_send: tool({
      description: 'Steer a running child at its next safe step boundary, or start a contextual follow-up turn after it finishes.',
      inputSchema: z.object({ sessionId: z.string(), message: z.string().min(1) }),
      execute: async (params) => call('subagent.send', params),
    }),

    subagent_interrupt: tool({
      description: 'Interrupt a child current turn without deleting its thread. Include message to redirect it into a new turn.',
      inputSchema: z.object({ sessionId: z.string(), message: z.string().min(1).optional() }),
      execute: async (params) => call('subagent.interrupt', params),
    }),

    subagent_stop: tool({
      description: 'Stop automatic child work while retaining the session transcript.',
      inputSchema: z.object({ sessionId: z.string() }),
      execute: async (params) => call('subagent.stop', params),
    }),

    subagent_status: tool({
      description: 'Read one child status and its latest result summary.',
      inputSchema: z.object({ sessionId: z.string() }),
      execute: async (params) => call('subagent.status', params),
    }),

    subagent_list: tool({
      description: 'List child threads in this task lineage, including uncollected completions.',
      inputSchema: z.object({}),
      execute: async () => call('subagent.list', {}),
    }),

    subagent_result: tool({
      description: 'Read a completed child response by character offset when the wait/status summary was truncated.',
      inputSchema: z.object({
        sessionId: z.string(),
        offset: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().positive().max(100_000).optional(),
      }),
      execute: async (params) => call('subagent.result', params),
    }),

    trace_query: tool({
      description: 'Query recent trace digest events for debugging agent actions. Returns redacted summaries and payload refs only.',
      inputSchema: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        days: z.number().int().positive().optional(),
        kind: z.string().optional(),
        actor: z.enum(['user', 'ai', 'package', 'system']).optional(),
        tool: z.string().optional(),
        packageId: z.string().optional(),
        sessionId: z.string().optional(),
        runId: z.string().optional(),
        traceId: z.string().optional(),
        status: z.enum(['ok', 'error']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      execute: async (params) => call('trace.query', params),
    }),

    trace_stats: tool({
      description: 'Aggregate trace health by tool, package, model, day, gate decision, job, and post-AI edit outcomes.',
      inputSchema: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        days: z.number().int().positive().optional(),
        kind: z.string().optional(),
        actor: z.enum(['user', 'ai', 'package', 'system']).optional(),
        tool: z.string().optional(),
        packageId: z.string().optional(),
        sessionId: z.string().optional(),
        runId: z.string().optional(),
        traceId: z.string().optional(),
        status: z.enum(['ok', 'error']).optional(),
      }),
      execute: async (params) => call('trace.stats', params),
    }),

    history_list: tool({
      description: 'List recoverable local versions for one workspace file. Default output is folded to useful recovery moments.',
      inputSchema: z.object({
        path: z.string(),
        include_folded: z.boolean().optional(),
      }),
      execute: async (params) => call('history.list', params),
    }),

    history_preview: tool({
      description: 'Preview a local recovery version. Text versions include content; binary versions return metadata.',
      inputSchema: z.object({
        path: z.string(),
        version_id: z.string(),
      }),
      execute: async (params) => call('history.preview', params),
    }),

    history_restore: tool({
      description: 'Restore a workspace file to a local recovery version. The restore is itself captured so it is undoable.',
      inputSchema: z.object({
        path: z.string(),
        version_id: z.string(),
      }),
      execute: async (params) => call('history.restore', params),
    }),

    sync_status: tool({
      description: 'Report plain-language workspace backup/sync status without using git terms.',
      inputSchema: z.object({}),
      execute: async () => call('sync.status', {}),
    }),

    sync_now: tool({
      description: 'Run managed workspace sync. Refuses manual mode and stops on conflicts instead of resolving silently.',
      inputSchema: z.object({}),
      execute: async () => call('sync.now', {}),
    }),

    git_status: tool({
      description: 'Read concise git status for advanced repository questions.',
      inputSchema: z.object({}),
      execute: async () => call('git.status', {}),
    }),

    git_diff: tool({
      description: 'Read git diff for the workspace or a path.',
      inputSchema: z.object({
        path: z.string().optional(),
        staged: z.boolean().optional(),
      }),
      execute: async (params) => call('git.diff', params),
    }),

    git_log: tool({
      description: 'Read recent git commits for the workspace.',
      inputSchema: z.object({
        limit: z.number().int().positive().optional(),
      }),
      execute: async (params) => call('git.log', params),
    }),

    git_commit: tool({
      description: 'Stage all workspace changes and create a git commit. Requires approval when policy requires it.',
      inputSchema: z.object({ message: z.string().min(1) }),
      execute: async (params) => call('git.commit', params),
    }),

    git_pull: tool({
      description: 'Pull the current branch with --ff-only. Requires approval when policy requires it.',
      inputSchema: z.object({}),
      execute: async () => call('git.pull', {}),
    }),

    git_push: tool({
      description: 'Push the current branch to its upstream. Requires approval when policy requires it.',
      inputSchema: z.object({}),
      execute: async () => call('git.push', {}),
    }),

    fs_write: tool({
      description: 'Overwrite an entire workspace file. The permission gate pauses for user approval when policy requires it.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => call('fs.write', { path, content }),
    }),

    comments_list: tool({
      description: 'List inline review comment threads in a file (markdown or code). Use before working through existing review comments.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => call('comments.list', { path }),
    }),

    comments_add: tool({
      description: 'Add an inline review comment anchored to exact visible text. Markdown files get inline <comment> tags; code files get an @mim marker line above the anchored line. Do not hand-edit comment markup.',
      inputSchema: z.object({
        path: z.string(),
        anchor_text: z.string().min(1),
        text: z.string(),
      }),
      execute: async ({ path, anchor_text, text }) => call('comments.add', { path, anchor_text, text }),
    }),

    comments_reply: tool({
      description: 'Reply to an existing inline review comment thread. Use this for discussion or to explain a document change.',
      inputSchema: z.object({
        path: z.string(),
        id: z.string().min(1),
        text: z.string(),
      }),
      execute: async ({ path, id, text }) => call('comments.reply', { path, id, text }),
    }),

    comments_resolve: tool({
      description: 'Resolve inline review comments. Pass id to resolve a single thread, or all=true to resolve every thread in the file. Removes comment wrappers and notes while keeping the anchored text.',
      inputSchema: z.object({
        path: z.string(),
        id: z.string().min(1).optional(),
        all: z.boolean().optional(),
      }),
      execute: async ({ path, id, all }) => call('comments.resolve', { path, ...(id ? { id } : {}), ...(all ? { all } : {}) }),
    }),

    fs_edit: tool({
      description: 'Edit a workspace file with search-and-replace. Exactly 1 match required. The permission gate pauses for user approval when policy requires it.',
      inputSchema: z.object({
        path: z.string(),
        old_text: z.string().min(1),
        new_text: z.string(),
      }),
      execute: async ({ path, old_text, new_text }) => call('fs.edit', { path, old_text, new_text }),
    }),

    fs_create: tool({
      description: 'Create a workspace file. Fails if the file exists. The permission gate pauses for user approval when policy requires it.',
      inputSchema: z.object({ path: z.string(), content: z.string().optional() }),
      execute: async ({ path, content }) => call('fs.create', { path, content: content ?? '' }),
    }),

    fs_delete: tool({
      description: 'Delete a workspace file. Directories are refused. The permission gate pauses for user approval when policy requires it.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => call('fs.delete', { path }),
    }),

    log_append: tool({
      description: 'Append a short durable activity note to the optional workspace logbook at .mim/log.md.',
      inputSchema: z.object({ message: z.string().min(1) }),
      execute: async ({ message }) => call('log.append', { message }),
    }),

    fs_list: tool({
      description: 'Capped result set. Recursive mode skips heavy/generated directories.',
      inputSchema: z.object({
        path: z.string().optional(),
        recursive: z.boolean().optional(),
        pattern: z.string().optional(),
        max_entries: z.number().int().positive().optional(),
      }),
      execute: async (params) => call('fs.list', params),
    }),

    fs_mkdir: tool({
      description: 'Recursive. No error if directory already exists.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => call('fs.mkdir', { path }),
    }),

    fs_rename: tool({
      description: 'Fails if destination exists.',
      inputSchema: z.object({ old_path: z.string(), new_path: z.string() }),
      execute: async ({ old_path, new_path }) => call('fs.rename', { old_path, new_path }),
    }),

    editor_open: tool({
      description: 'Open a file in the Editor',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => call('editor.open', { path }),
    }),

    bash: tool({
      description:
        'Run a shell command in the workspace and return its captured output: exit code, stdout/stderr tails, ' +
        'and files the run created or changed (products). Write code to real files and run them — do not inline ' +
        'long scripts with -e. After a run that produced a figure, PDF, or table, open the best product with ' +
        'editor_open. If a run fails, read the stderr tail, fix, re-run. Running the exact form `Rscript file.R` ' +
        'captures base-graphics plots automatically. To render R Markdown/Quarto, run quarto render (or ' +
        'rmarkdown::render) and open the produced PDF. Set terminal:true to type the command into the user\'s ' +
        'visible terminal instead (no output capture) — use that for dev servers, watch modes, and anything the ' +
        'user should own and watch.',
      inputSchema: z.object({
        command: z.string().min(1),
        terminal: z.boolean().optional(),
        timeout_ms: z.number().optional(),
        capture_plots: z.boolean().optional(),
      }),
      execute: async (params) => call('shell.run', params),
    }),

    package_create: tool({
      description: 'Create a new workspace package, including headless packages with backend tools/jobs and optional package skills. html is optional; omit it for tools-only packages.',
      inputSchema: packageCreateInputSchema,
      execute: async (params) => call('package.create', params),
    }),

    package_validate: tool({
      description: 'Validate a workspace package and return structured errors/warnings for manifest, backend exports, named tools, skills, and permission hints.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => call('package.validate', { id }),
    }),

    package_reload: tool({
      description: 'Rescan packages and reload backend capabilities so edits take effect without restarting Mim. Use after package.create or package.edit before testing.',
      inputSchema: z.object({ id: z.string().optional() }),
      execute: async (params) => call('package.reload', params),
    }),

    package_edit: tool({
      description: 'Edit a package file',
      inputSchema: z.object({
        id: z.string(),
        file: z.string(),
        content: z.string(),
      }),
      execute: async (params) => call('package.edit', params),
    }),

    package_delete: tool({
      description: 'Remove a package',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => call('package.delete', { id }),
    }),

    package_list: tool({
      description: 'List available Mim, Team, and Project apps',
      inputSchema: z.object({}),
      execute: async () => call('package.list', {}),
    }),

    app_status: tool({
      description: 'Read Mim, Team, and Project apps with local activation, origin, permission-review, and data-folder state.',
      inputSchema: z.object({}),
      execute: async () => call('app.status', {}),
    }),

    app_enable: tool({
      description: 'Enable an available app for this person in the current Project. Permission review remains a user action in Settings > Apps & agents.',
      inputSchema: z.object({
        id: z.string(),
      }),
      execute: async (params) => call('app.enable', params),
    }),

    package_readme: tool({
      description: 'Read the README.md documentation for an available app by id.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => call('package.readme', { id }),
    }),

    package_capabilities_list: tool({
      description: 'List enabled package jobs, tools, skills, and runtime diagnostics. Use after enabling/reloading to verify what Mim can see.',
      inputSchema: z.object({}),
      execute: async () => call('package.capabilities.list', {}),
    }),

    package_tools_execute: tool({
      description: 'Execute an enabled package AI tool by public name for testing during package authoring.',
      inputSchema: z.object({
        name: z.string(),
        input: looseObjectSchema.optional(),
      }),
      execute: async ({ name, input }) => {
        if (!registryToolEnabled(toolPolicy, name)) throw new Error(`Tool is disabled by Settings > Tools: ${name}`)
        return call('package.tools.execute', { name, input: input ?? {} })
      },
    }),

    package_jobs_start: tool({
      description: 'Start an enabled package backend job by packageId and jobId for testing during package authoring.',
      inputSchema: z.object({
        packageId: z.string().optional(),
        jobId: z.string(),
        inputs: looseObjectSchema.optional(),
      }),
      execute: async (params) => call('package.jobs.start', params),
    }),

    connections_status: tool({
      description: 'Check connection status for all integrations (Google, Slack). Returns what is configured, who is authenticated, granted scopes, and setup guidance. Also checks Slack bot accounts referenced by workspace routines. Always available regardless of policy.',
      inputSchema: z.object({}),
      execute: async () => {
        const routineSlackAccountsPromise = call('routine.list', {})
          .then(routineSlackAccounts)
          .catch(() => [])
        const [google, slack, slackBot, slackBotCheck, routineSlackAccountLabels] = await Promise.all([
          call('google.status', {}).catch(() => null),
          call('slack.status', {}).catch(() => null),
          call('slack.bot.status', {}).catch(() => null),
          call('slack.bot.check', {}).catch(() => null),
          routineSlackAccountsPromise,
        ])
        const slackBots = await Promise.all(
          routineSlackAccountLabels
            .filter(account => account !== 'default')
            .map(account => call('slack.bot.status', { account }).catch(() => null)),
        )
        return {
          google,
          slack,
          slackBot,
          slackBotCheck,
          ...(slackBots.length ? { slackBots: slackBots.filter(Boolean) } : {}),
        }
      },
    }),

    google_set_oauth_client: tool({
      description: 'Store a Google OAuth client in the OS keychain. Pass a file path to a Google Cloud Console JSON download (recommended — credentials never enter chat), or inline client_id and client_secret.',
      inputSchema: z.object({
        file: z.string().optional(),
        client_id: z.string().optional(),
        client_secret: z.string().optional(),
        account: z.string().optional(),
      }),
      execute: async (params) => call('google.setOAuthClient', dropEmpty(params)),
    }),

    google_connect: tool({
      description: 'Connect Google. Set oauth=true for browser sign-in (recommended). Or pass a file path to a token bundle JSON, or inline access_token. Browser sign-in opens the consent page, the user authorizes, and the token is stored automatically.',
      inputSchema: z.object({
        oauth: z.boolean().optional(),
        capabilities: z.array(z.string()).optional(),
        scopes: z.array(z.string()).optional(),
        file: z.string().optional(),
        access_token: z.string().optional(),
        refresh_token: z.string().optional(),
        expires_at: z.number().optional(),
        scope: z.string().optional(),
        account: z.string().optional(),
      }),
      execute: async (params) => call('google.connect', dropEmpty(params)),
    }),

    google_disconnect: tool({
      description: 'Remove Google tokens from the OS keychain.',
      inputSchema: z.object({ account: z.string().optional() }),
      execute: async (params) => call('google.disconnect', dropEmpty(params)),
    }),

    slack_connect: tool({
      description: 'Connect Slack. Pass a file path to a token file (recommended — token never enters chat), or an inline token. The token is stored in the OS keychain and verified with Slack.',
      inputSchema: z.object({
        file: z.string().optional(),
        token: z.string().optional(),
        account: z.string().optional(),
      }),
      execute: async (params) => call('slack.connect', dropEmpty(params)),
    }),

    slack_disconnect: tool({
      description: 'Remove a Slack token from the OS keychain.',
      inputSchema: z.object({ account: z.string().optional() }),
      execute: async (params) => call('slack.disconnect', dropEmpty(params)),
    }),

    slack_bot_connect: tool({
      description: 'Connect a Slack bot listener. Pass a JSON file path with bot_token and app_token (recommended), or inline bot_token and app_token. Stores both in the OS keychain and verifies bot auth plus Socket Mode.',
      inputSchema: z.object({
        file: z.string().optional(),
        bot_token: z.string().optional(),
        app_token: z.string().optional(),
        account: z.string().optional(),
      }),
      execute: async (params) => call('slack.bot.connect', dropEmpty(params)),
    }),

    slack_bot_disconnect: tool({
      description: 'Remove Slack bot and Socket Mode tokens from the OS keychain.',
      inputSchema: z.object({ account: z.string().optional() }),
      execute: async (params) => call('slack.bot.disconnect', dropEmpty(params)),
    }),

    slack_bot_setup: tool({
      description: 'Set up a Slack bot for this workspace in one step: optionally store bot/app tokens, create or update the channel routine, choose capability groups, and enable it locally. Returns a readiness checklist.',
      inputSchema: z.object({
        file: z.string().optional(),
        bot_token: z.string().optional(),
        app_token: z.string().optional(),
        account: z.string().optional(),
        channel: z.string(),
        mode: z.enum(['mention', 'always']).optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        body: z.string().optional(),
        capabilities: z.array(z.enum([
          'workspace_read',
          'sessions_read',
          'issues_read',
          'issues_write',
          'files_write',
          'slack_read',
          'slack_send',
          'terminal',
        ])).optional(),
        tools: z.array(z.string()).optional(),
        approvalAllow: z.array(z.string()).optional(),
      }),
      execute: async (params) => call('slack.bot.setup', dropEmpty(params)),
    }),

    slack_bot_check: tool({
      description: 'Check the workspace Slack bot readiness in one result: routine binding, local enablement, credentials, and live listener availability.',
      inputSchema: z.object({
        account: z.string().optional(),
        channel: z.string().optional(),
        name: z.string().optional(),
      }),
      execute: async (params) => call('slack.bot.check', dropEmpty(params)),
    }),

    connections_configure: tool({
      description: 'Enable or disable integration capabilities for the AI agent. Set policy flags like aiEnabled, gmailEnabled, calendarEnabled, driveEnabled, sendEnabled, etc.',
      inputSchema: z.object({
        integration: z.enum(['google', 'slack']),
        aiEnabled: z.boolean().optional(),
        gmailEnabled: z.boolean().optional(),
        gmailSendEnabled: z.boolean().optional(),
        calendarEnabled: z.boolean().optional(),
        calendarWriteEnabled: z.boolean().optional(),
        driveEnabled: z.boolean().optional(),
        sheetsWriteEnabled: z.boolean().optional(),
        sendEnabled: z.boolean().optional(),
        privateChannels: z.boolean().optional(),
        directMessages: z.boolean().optional(),
      }),
      execute: async ({ integration, ...flags }) => {
        const boolFlags: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(flags)) {
          if (typeof value === 'boolean') boolFlags[key] = value
        }
        let enableIds: string[] = []
        const disableIds: string[] = []
        for (const [key, value] of Object.entries(boolFlags)) {
          const ids = connectorFlagToolIds(integration, key, value)
          if (value) enableIds.push(...ids)
          else disableIds.push(...ids)
        }
        const userDisabled = new Set(toolPolicy.disabled)
        const blocked = enableIds.filter(id => userDisabled.has(id))
        if (blocked.length) enableIds = enableIds.filter(id => !userDisabled.has(id))
        if (enableIds.length) await call('toolPolicy.set', { toolIds: uniqueStrings(enableIds), enabled: true })
        if (disableIds.length) await call('toolPolicy.set', { toolIds: uniqueStrings(disableIds), enabled: false })
        return {
          integration,
          configured: boolFlags,
          ...(blocked.length ? { blocked, hint: 'Some tools are disabled in Settings > Tools' } : {}),
        }
      },
    }),

  }

  // Dynamic entries only added when their key is not already present (static wins)
  for (const [key, value] of Object.entries(dynamicPackageTools)) {
    if (!(key in staticTools)) {
      (staticTools as Record<string, unknown>)[key] = value
    }
  }

  return filterAiToolMap(staticTools, toolPolicy)
}

function filterAiToolMap<T extends Record<string, ReturnType<typeof tool>>>(
  tools: T,
  policy: EffectiveToolPolicy,
): T {
  const filtered: Partial<T> = {}
  for (const [key, value] of Object.entries(tools) as Array<[keyof T & string, T[keyof T]]>) {
    if (aiToolKeyEnabled(policy, key)) filtered[key] = value
  }
  return filtered as T
}

function connectorFlagToolIds(integration: 'google' | 'slack', key: string, enabled: boolean): string[] {
  if (integration === 'slack') {
    if (key === 'aiEnabled') {
      const readIds = ['slack.search', 'slack.history', 'slack.channels', 'slack.replies', 'slack.users']
      if (!enabled) return [...readIds, 'slack.send', 'slack.dms', 'slack.directMessages', 'slack.privateChannels']
      return readIds
    }
    if (key === 'sendEnabled') return ['slack.send']
    if (key === 'privateChannels') return ['slack.privateChannels']
    if (key === 'directMessages') return ['slack.dms', 'slack.directMessages']
    return []
  }
  if (key === 'aiEnabled') {
    if (enabled) return []
    return [
      'gmail.search',
      'gmail.read',
      'gmail.send',
      'calendar.events',
      'calendar.create',
      'drive.search',
      'drive.meta',
      'docs.read',
      'sheets.meta',
      'sheets.read',
      'sheets.write',
      'sheets.append',
    ]
  }
  if (key === 'gmailEnabled') return ['gmail.search', 'gmail.read']
  if (key === 'gmailSendEnabled') return ['gmail.send']
  if (key === 'calendarEnabled') return ['calendar.events']
  if (key === 'calendarWriteEnabled') return ['calendar.create']
  if (key === 'driveEnabled') return ['drive.search', 'drive.meta', 'docs.read', 'sheets.meta', 'sheets.read']
  if (key === 'sheetsWriteEnabled') return ['sheets.write', 'sheets.append']
  return []
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

async function resolveGoogleAiToolState(
  call: (name: string, params?: Record<string, unknown>) => Promise<unknown>,
  policy: GoogleConnectorPolicy,
) {
  if (!policy.aiEnabled) return { policy, connected: false, grantedScopes: [] }
  try {
    const status = await call('google.status', {}) as {
      configured?: boolean
      tokenConfigured?: boolean
      grantedScopes?: unknown
    }
    return {
      policy,
      connected: status.configured === true || status.tokenConfigured === true,
      grantedScopes: Array.isArray(status.grantedScopes)
        ? status.grantedScopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
    }
  } catch {
    return { policy, connected: false, grantedScopes: [] }
  }
}

export function createSkillActiveToolPolicy(
  allToolNames: string[],
  activatedSkillTools: Set<string>,
  gatedToolNames: Set<string>,
) {
  // Normalize through aiToolKey so dotted unlock names match sanitized SDK keys
  // Personal-skill mutation is intrinsically skill-gated: if the declaring
  // Team skill is unavailable or disabled, these tools must stay hidden.
  const gated = new Set([
    ...gatedToolNames,
    'skill.create',
    'skill.update',
  ].map(aiToolKey))
  // The activation tool must always stay visible, whatever a skill declares.
  gated.delete('skill')
  const allNormalized = allToolNames.map(aiToolKey)
  const allSet = new Set(allNormalized)
  const baseTools = allToolNames.filter(name => !gated.has(aiToolKey(name)))
  const activeTools = () => [
    ...baseTools,
    ...[...activatedSkillTools]
      .map(aiToolKey)
      .filter(key => gated.has(key) && allSet.has(key))
      .map(key => allToolNames[allNormalized.indexOf(key)])
      .filter(Boolean),
  ]

  return {
    activeTools: activeTools(),
    prepareStep: () => ({ activeTools: activeTools() }),
  }
}

// Deterministic activation for composer-selected skill chips: the bodies are
// injected into the system prompt and the declared tools unlock from step one,
// instead of hoping the model calls skill() first.
export function activateSelectedSkills(
  loader: Pick<SkillLoader, 'get'>,
  names: string[] | undefined,
): { promptSection: string | null; toolNames: string[] } {
  const requested = [...new Set(
    (names ?? []).map(name => typeof name === 'string' ? name.trim() : '').filter(Boolean),
  )]
  if (!requested.length) return { promptSection: null, toolNames: [] }

  const bodies: string[] = []
  const missing: string[] = []
  const toolNames: string[] = []
  for (const name of requested) {
    const skill = loader.get(name)
    if (!skill) {
      missing.push(name)
      continue
    }
    for (const toolName of [...skill.tools, ...skill.unlocks]) {
      if (!toolNames.includes(toolName)) toolNames.push(toolName)
    }
    bodies.push(`## ${skill.name}\n\n${skill.body}`)
  }

  const lines = [
    '# ACTIVE SKILLS',
    '',
    'The user selected these skills for this request. Their instructions are already active and their tools are unlocked; do not call skill() for them again.',
  ]
  if (bodies.length) lines.push('', bodies.join('\n\n'))
  if (missing.length) lines.push('', `These selected skills are unavailable and were not activated: ${missing.join(', ')}. Mention this if it affects the task.`)

  return { promptSection: lines.join('\n'), toolNames }
}

async function activateSelectedSkillsFromRegistry(
  tools: ToolRegistry,
  names: string[] | undefined,
  ctx: { sessionId?: string; routine?: ToolContext['routine']; subagent?: ToolContext['subagent']; traceId?: string; spanId?: string } = {},
): Promise<{ promptSection: string | null; toolNames: string[] }> {
  const requested = [...new Set(
    (names ?? []).map(name => typeof name === 'string' ? name.trim() : '').filter(Boolean),
  )]
  if (!requested.length) return { promptSection: null, toolNames: [] }

  const bodies: string[] = []
  const missing: string[] = []
  const toolNames: string[] = []

  for (const name of requested) {
    try {
      const result = await tools.call('skill.get', { name }, {
        actor: 'ai',
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.routine ? { routine: ctx.routine } : {}),
        ...(ctx.subagent ? { subagent: ctx.subagent } : {}),
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        ...(ctx.spanId ? { spanId: ctx.spanId } : {}),
      }) as { skill?: unknown }
      const skill = normalizeActivatedSkill(result.skill)
      for (const toolName of [...skill.tools, ...skill.unlocks]) {
        if (!toolNames.includes(toolName)) toolNames.push(toolName)
      }
      bodies.push(`## ${skill.name}\n\n${skill.body ?? ''}`.trim())
    } catch {
      missing.push(name)
    }
  }

  const lines = [
    '# ACTIVE SKILLS',
    '',
    'The user selected these skills for this request. Their instructions are already active and their tools are unlocked; do not call skill() for them again.',
  ]
  if (bodies.length) lines.push('', bodies.join('\n\n'))
  if (missing.length) lines.push('', `These selected skills are unavailable and were not activated: ${missing.join(', ')}. Mention this if it affects the task.`)

  return { promptSection: lines.join('\n'), toolNames }
}

function normalizeActivatedSkill(raw: unknown): ActivatedSkill {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid skill result')
  }
  const item = raw as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name : ''
  if (!name) throw new Error('Invalid skill result')
  return {
    name,
    description: typeof item.description === 'string' ? item.description : undefined,
    body: typeof item.body === 'string' ? item.body : undefined,
    revision: typeof item.revision === 'string' ? item.revision : undefined,
    tools: Array.isArray(item.tools) ? item.tools.filter((toolName): toolName is string => typeof toolName === 'string') : [],
    unlocks: Array.isArray(item.unlocks) ? item.unlocks.filter((toolName): toolName is string => typeof toolName === 'string') : [],
  }
}

export async function streamProfileResponse({
  profile,
  tools,
  request,
}: {
  profile: AgentProfile
  tools: ToolRegistry
  request: StreamRequest
}): Promise<Response> {
  const registry = loadRegistry()
  const effectiveModelId = request.modelId || profile.defaultModelId
  const modelConfig = resolveRequestModel(registry, profile.modelFeature, effectiveModelId)
  const { key } = resolveKey(modelConfig.provider)
  if (!key) throw new Error(`No API key configured for ${modelConfig.provider}`)
  const { model } = await createSdkModel({ registry, modelConfig, apiKey: key })
  const sessionId = request.id
  // The turn is the trace: model calls, the pre-flight skill/package listing,
  // tool calls, and the closing persistence all nest under this root span, so
  // one chat send is one run in the Activity feed (not a scatter of orphan
  // traces). Created up front so the listing below can parent to it.
  const parentTrace = request.trace
  const turnTraceId = parentTrace?.traceId ?? newTraceId()
  const turnSpanId = newSpanId()
  const turnStartedAt = Date.now()
  const turnTrace = { traceId: turnTraceId, spanId: turnSpanId }
  const delegation = request.subagent ?? (sessionId ? {
    rootSessionId: sessionId,
    parentSessionId: sessionId,
    depth: 0,
    modelId: effectiveModelId ?? modelConfig.id,
    profileId: profile.id,
    toolAllowlist: profile.toolAllowlist,
    approvalAllow: request.routine?.approvalAllow,
    originActor: 'ai' as const,
  } : undefined)
  tools.trace.append({
    kind: 'chat.turn',
    actor: 'ai',
    traceId: turnTraceId,
    spanId: turnSpanId,
    ...(parentTrace ? { parentSpanId: parentTrace.spanId } : {}),
    ...(sessionId ? { sessionId } : {}),
    model: modelConfig.model,
    data: {
      profile: profile.id,
      ...(request.routine ? { routineId: request.routine.id, routineRunId: request.routine.runId } : {}),
    },
  })
  const [packageTools, skillCatalog] = profile.useCatalogs
    ? await Promise.all([listPackageTools(tools, sessionId, turnTrace), listSkillCatalog(tools, sessionId, turnTrace)])
    : [[], []] as const
  const gatedToolNames = skillUnlocksFromCatalog(skillCatalog)
  const activatedSkillTools = new Set<string>()
  let aiTools = await createAiSdkTools({
    tools,
    profile: profile.toolSurface,
    sessionId,
    packageTools,
    onSkillActivated: skill => {
      for (const name of skill.tools) activatedSkillTools.add(name)
      for (const name of skill.unlocks) activatedSkillTools.add(name)
    },
    routine: request.routine,
    subagent: delegation,
    trace: { traceId: turnTraceId, spanId: turnSpanId },
  })
  // Allowlist filtering: when the profile declares a toolAllowlist, narrow the
  // tool map BEFORE the active-tool policy snapshots Object.keys(aiTools).
  if (profile.toolAllowlist) {
    const allowed = new Set(profile.toolAllowlist.map(canonicalToolIdToAiKey))
    // The `skill` key is additionally kept iff the profile has preActivatedSkills
    if (profile.preActivatedSkills?.length) allowed.add('skill')
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(aiTools)) {
      if (allowed.has(key)) filtered[key] = value
    }
    aiTools = filtered as typeof aiTools
  }
  // Merge preActivatedSkills BEFORE request.skills into the skill activation call
  const mergedSkills = [
    ...(profile.preActivatedSkills ?? []),
    ...(request.skills ?? []),
  ]
  const selectedSkills = profile.useCatalogs
    ? await activateSelectedSkillsFromRegistry(tools, mergedSkills, {
        sessionId,
        routine: request.routine,
        subagent: delegation,
        traceId: turnTraceId,
        spanId: turnSpanId,
      })
    : { promptSection: null, toolNames: [] }
  // Pre-activated tools must land in the set before the policy snapshots its
  // initial activeTools, so composer-selected skills are usable from step one.
  selectedSkills.toolNames.forEach(toolName => activatedSkillTools.add(toolName))
  const activeToolPolicy = profile.useCatalogs
    ? createSkillActiveToolPolicy(Object.keys(aiTools), activatedSkillTools, gatedToolNames)
    : null
  const normalizedMessages = normalizeFileUIParts(request.messages || [])
  const injectedSubagentMessages: UIMessage[] = []
  const prepareAgentStep = request.consumeSubagentInbox
    ? async (step: { messages: unknown[] }) => {
        const activeTools = activeToolPolicy?.prepareStep() ?? {}
        const inbox = normalizeFileUIParts(await request.consumeSubagentInbox!())
        if (!inbox.length) return activeTools
        injectedSubagentMessages.push(...inbox)
        const modelMessages = await convertToModelMessages(inbox, {
          tools: aiTools,
          ignoreIncompleteToolCalls: true,
          convertDataPart: convertMimDataPart,
        })
        await request.onSubagentActivity?.(`Received ${inbox.length} steering message${inbox.length === 1 ? '' : 's'}`)
        return {
          ...activeTools,
          messages: [...step.messages, ...modelMessages],
        }
      }
    : activeToolPolicy?.prepareStep
  let sessionCompactions = profile.persistSession && sessionId
    ? await prepareSessionCompactionsBeforeTurn({
        tools,
        sessionId,
        requestMessages: normalizedMessages,
        modelConfig,
        trace: turnTrace,
      })
    : []
  const preparePrompt = async (compactions: ContextCompactionRecord[]) => {
    const modelContext = buildModelContext({
      messages: normalizedMessages,
      compactions,
      modelWindow: modelConfig.contextWindow,
    })
    const uiMessages = await validateUIMessages({
      messages: modelContext.messages,
      tools: aiTools,
      dataSchemas: { context: contextDataSchema },
    })
    const modelMessages = await convertToModelMessages(uiMessages, {
      tools: aiTools,
      ignoreIncompleteToolCalls: true,
      convertDataPart: convertMimDataPart,
    })
    return {
      modelMessages,
      estimatedContextTokens: estimateMessagesTokens(uiMessages),
    }
  }
  let preparedPrompt = await preparePrompt(sessionCompactions)
  const turnUsageSteps: UsageSummary[] = []

  const instructions = await profile.buildInstructions({
    workspacePath: tools.getWorkspacePath() ?? undefined,
    skillCatalog,
    selectedSkillsSection: selectedSkills.promptSection,
    request,
    trace: turnTrace,
  })
  if (profile.persistSession && sessionId) {
    const promptTokens = estimatePreparedPromptTokens(preparedPrompt, instructions, aiTools)
    if (shouldCompactForContextWindow(promptTokens, modelConfig.contextWindow)) {
      try {
        const compaction = await maybeCompactSessionAfterTurn({
          tools,
          sessionId,
          messages: normalizedMessages,
          modelConfig,
          contextTokens: promptTokens,
          trigger: 'pre_turn',
          trace: turnTrace,
        })
        if (compaction) {
          sessionCompactions = [...sessionCompactions, compaction.record]
          preparedPrompt = await preparePrompt(sessionCompactions)
        }
      } catch (error) {
        tools.trace.append({
          kind: 'chat.compaction',
          actor: 'ai',
          traceId: turnTraceId,
          parentSpanId: turnSpanId,
          status: 'error',
          sessionId,
          model: modelConfig.model,
          data: {
            trigger: 'pre_turn',
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }

  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools: aiTools,
    activeTools: activeToolPolicy?.activeTools as any,
    prepareStep: prepareAgentStep as any,
    // Chat cap is a runaway backstop, not a task limit — the renderer shows a
    // Continue notice when it's hit (ChatView step-cap notice tracks this number).
    stopWhen: stepCountIs(profile.stepCap),
    maxOutputTokens: profile.maxOutputTokens,
    temperature: profile.temperature,
    providerOptions: buildProviderOptions(modelConfig, request.controlId),
    onStepFinish(event) {
      const toolNames = Array.isArray(event.toolCalls)
        ? event.toolCalls.flatMap(call => typeof call.toolName === 'string' ? [call.toolName] : [])
        : []
      void request.onSubagentActivity?.(toolNames.length
        ? `Using ${toolNames.join(', ')}`
        : 'Model step completed')
      if (event.usage) {
        const usage = normalizeSdkUsage(event.usage, modelConfig, { finishReason: event.finishReason })
        turnUsageSteps.push(usage)
        tools.trace.append({
          kind: 'model.call',
          actor: 'ai',
          traceId: turnTraceId,
          parentSpanId: turnSpanId,
          ...(sessionId ? { sessionId } : {}),
          model: modelConfig.model,
          data: {
            profile: profile.id,
            ...usage,
            ...(request.routine ? { routineId: request.routine.id, routineRunId: request.routine.runId } : {}),
          },
        })
      }
    },
  })

  let result: Awaited<ReturnType<typeof agent.stream>>
  try {
    result = await agent.stream({
      prompt: preparedPrompt.modelMessages,
      abortSignal: request.abortSignal,
    })
  } catch (error) {
    if (
      !profile.persistSession ||
      !sessionId ||
      !isContextLengthError(error, modelConfig.provider)
    ) {
      if (request.routine && sessionId) {
        await markRoutineSessionError(tools, sessionId, error instanceof Error ? error.message : String(error), turnTrace)
      }
      throw error
    }

    const compaction = await maybeCompactSessionAfterTurn({
      tools,
      sessionId,
      messages: normalizedMessages,
      modelConfig,
      contextTokens: overflowContextTokens(preparedPrompt.estimatedContextTokens, modelConfig.contextWindow),
      trigger: 'overflow',
      trace: turnTrace,
      force: true,
    }).catch(compactionError => {
      tools.trace.append({
        kind: 'chat.compaction',
        actor: 'ai',
        traceId: turnTraceId,
        parentSpanId: turnSpanId,
        status: 'error',
        sessionId,
        model: modelConfig.model,
        data: {
          trigger: 'overflow',
          error: compactionError instanceof Error ? compactionError.message : String(compactionError),
        },
      })
      return null
    })
    if (!compaction) {
      if (request.routine && sessionId) {
        await markRoutineSessionError(tools, sessionId, error instanceof Error ? error.message : String(error), turnTrace)
      }
      throw error
    }

    sessionCompactions = [...sessionCompactions, compaction.record]
    preparedPrompt = await preparePrompt(sessionCompactions)
    result = await agent.stream({
      prompt: preparedPrompt.modelMessages,
      abortSignal: request.abortSignal,
    })
  }

  return result.toUIMessageStreamResponse({
    originalMessages: normalizedMessages,
    sendReasoning: profile.sendReasoning,
    onFinish: async ({ messages }) => {
      const completedMessages = mergeInjectedSubagentMessages(
        normalizedMessages,
        injectedSubagentMessages,
        messages,
      )
      // Capture only this user turn and its response. The full conversation is
      // canonical in session storage; re-blobbing it after every turn creates
      // quadratic trace growth in long chats.
      const messagesRef = tools.shouldCaptureContent()
        ? tools.trace.writePayload(
            turnTraceId,
            turnSpanId,
            'messages',
            completedTurnMessages(normalizedMessages, completedMessages),
          )
        : null
      tools.trace.append({
        kind: 'chat.turn.done',
        actor: 'ai',
        traceId: turnTraceId,
        spanId: turnSpanId,
        status: 'ok',
        durationMs: Date.now() - turnStartedAt,
        ...(sessionId ? { sessionId } : {}),
        model: modelConfig.model,
        data: {
          profile: profile.id,
          steps: turnUsageSteps.length,
          ...(request.routine ? { routineId: request.routine.id, routineRunId: request.routine.runId } : {}),
        },
        ...(messagesRef ? { payloadRef: messagesRef } : {}),
      })
      if (!profile.persistSession || !sessionId) return
      const turnUsage = summarizeTurnUsage(turnUsageSteps, preparedPrompt.estimatedContextTokens)
      await persistChatSession(tools, sessionId, completedMessages, turnUsage.usage, turnUsage.contextTokens, turnTrace)
      if (request.routine) await markRoutineSessionDone(tools, sessionId, turnTrace)
      await maybeCompactSessionAfterTurn({
        tools,
        sessionId,
        messages: completedMessages,
        modelConfig,
        contextTokens: turnUsage.contextTokens,
        trigger: 'post_turn',
        trace: turnTrace,
      }).catch(error => {
        tools.trace.append({
          kind: 'chat.compaction',
          actor: 'ai',
          traceId: turnTraceId,
          parentSpanId: turnSpanId,
          status: 'error',
          ...(sessionId ? { sessionId } : {}),
          model: modelConfig.model,
          data: {
            trigger: 'post_turn',
            error: error instanceof Error ? error.message : String(error),
          },
        })
      })
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'AI request failed'
      if (request.routine && sessionId) void markRoutineSessionError(tools, sessionId, message, turnTrace)
      return message
    },
  })
}

export function convertMimDataPart(part: { type: string; data: unknown }) {
  if (part.type !== 'data-context') return undefined
  const data = contextDataSchema.parse(part.data)
  return {
    type: 'text' as const,
    text: formatContextForModel(data),
  }
}

function formatContextForModel(data: MimContextData): string {
  const filename = escapeXmlAttribute(data.filename || 'attachment.txt')
  const mediaType = escapeXmlAttribute(data.mediaType || 'text/plain')
  const path = typeof (data as Record<string, unknown>).path === 'string'
    ? escapeXmlAttribute((data as Record<string, string>).path)
    : null
  if ((data as Record<string, unknown>).kind === 'comments') {
    const commentPath = path ?? escapeXmlAttribute(data.filename)
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(data.content) } catch { /* use raw content below */ }
    const doc = typeof parsed.document === 'string' ? parsed.document : null
    const instruction = typeof parsed.instruction === 'string' ? parsed.instruction : ''
    const parts = [
      `<attached-comments path="${commentPath}" name="${filename}">`,
    ]
    if (instruction) parts.push(`<instruction>${instruction}</instruction>`)
    if (doc) {
      parts.push(`<document path="${commentPath}">`)
      parts.push(doc)
      parts.push('</document>')
    } else {
      parts.push(data.content)
    }
    parts.push('</attached-comments>')
    return parts.join('\n')
  }
  const pathAttribute = path ? ` path="${path}"` : ''
  return [
    `<attached-file${pathAttribute} name="${filename}" media-type="${mediaType}">`,
    data.content,
    '</attached-file>',
  ].join('\n')
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function completedTurnMessages(originalMessages: UIMessage[], completedMessages: UIMessage[]): UIMessage[] {
  let currentUserIndex = -1
  for (let index = originalMessages.length - 1; index >= 0; index--) {
    if (originalMessages[index]?.role === 'user') {
      currentUserIndex = index
      break
    }
  }
  const start = currentUserIndex >= 0 ? currentUserIndex : Math.min(originalMessages.length, completedMessages.length)
  return completedMessages.slice(start)
}

export function mergeInjectedSubagentMessages(
  originalMessages: UIMessage[],
  injectedMessages: UIMessage[],
  completedMessages: UIMessage[],
): UIMessage[] {
  if (!injectedMessages.length) return completedMessages
  const generated = completedMessages.slice(Math.min(originalMessages.length, completedMessages.length))
  return [...originalMessages, ...injectedMessages, ...generated]
}

export function normalizeFileUIParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = (message as { parts?: unknown[] }).parts
    if (!Array.isArray(parts)) return message

    let changed = false
    const nextParts = parts.map((part) => {
      if (!part || typeof part !== 'object') return part
      const item = part as Record<string, unknown>
      if (item.type !== 'file') return part

      const mediaType = typeof item.mediaType === 'string' ? item.mediaType : 'text/plain'
      if (isTextFileMediaType(mediaType)) {
        changed = true
        return {
          type: 'data-context',
          data: {
            filename: typeof item.filename === 'string' && item.filename
              ? item.filename
              : 'attachment.txt',
            mediaType,
            content: textFileContent(item),
          },
        }
      }

      if (item.data == null) return part

      changed = true
      const { data: rawData, ...withoutData } = item
      return {
        ...withoutData,
        url: typeof withoutData.url === 'string' && withoutData.url
          ? withoutData.url
          : textDataUrl(typeof item.mediaType === 'string' ? item.mediaType : 'text/plain', rawData),
      }
    })

    return changed ? { ...message, parts: nextParts } : message
  })
}

function isTextFileMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'application/json'
}

function textFileContent(part: Record<string, unknown>): string {
  if (part.data != null) return String(part.data)
  if (part.content != null) return String(part.content)
  if (typeof part.url === 'string') return textFromDataUrl(part.url)
  return ''
}

function textFromDataUrl(url: string): string {
  const match = /^data:[^;,]+(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(url)
  if (!match) return ''
  try {
    return Buffer.from(match[1], 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

function textDataUrl(mediaType: string, data: unknown): string {
  return `data:${mediaType};base64,${Buffer.from(String(data ?? ''), 'utf-8').toString('base64')}`
}

async function generateGhostSuggestions({
  tools,
  request,
}: {
  tools: ToolRegistry
  request: GhostRequest
}): Promise<{ suggestions: string[] }> {
  const registry = loadRegistry()
  const modelConfig = resolveRequestModel(registry, 'ghost', request.modelId)
  const { key } = resolveKey(modelConfig.provider)
  if (!key) throw new Error(`No API key configured for ${modelConfig.provider}`)
  const { model } = await createSdkModel({ registry, modelConfig, apiKey: key })
  const startedAt = Date.now()
  const result = await generateObject({
    model,
    schema: z.object({
      suggestions: z.array(z.string()).min(0).max(5),
    }),
    system: buildGhostSystemPrompt(request.before),
    prompt: `<prefix>${escapePromptXml(request.before)}</prefix>\n<cursor/>\n<suffix>${escapePromptXml(request.after)}</suffix>`,
    maxOutputTokens: 700,
    temperature: 0.35,
    providerOptions: buildProviderOptions(modelConfig),
  })

  traceModelCall(tools, 'ghost', modelConfig, result.usage, Date.now() - startedAt, result.finishReason)
  const suggestions = cleanSuggestions(result.object?.suggestions)
  return { suggestions: suggestions.length ? suggestions : cleanSuggestions(request.fallback || []) }
}

async function generateTaskLabel({
  tools,
  request,
}: {
  tools: ToolRegistry
  request: TaskLabelRequest
}): Promise<{ label: string }> {
  const userText = String(request.userText || '').trim()
  if (!userText) return { label: '' }

  const registry = loadRegistry()
  const modelConfig = resolveRequestModel(registry, 'extract', request.modelId)
  const { key } = resolveKey(modelConfig.provider)
  if (!key) throw new Error(`No API key configured for ${modelConfig.provider}`)
  const { model } = await createSdkModel({ registry, modelConfig, apiKey: key })
  const startedAt = Date.now()
  const result = await generateObject({
    model,
    schema: z.object({
      label: z.string().describe('Compact sidebar task label, 2-4 words, target 3 words, no trailing punctuation'),
    }),
    system: buildTaskLabelSystemPrompt(),
    prompt: buildTaskLabelPrompt({
      userText,
      contextLabels: request.contextLabels || [],
    }),
    maxOutputTokens: 120,
    temperature: 0.2,
    providerOptions: buildProviderOptions(modelConfig),
  })

  traceModelCall(tools, 'task-label', modelConfig, result.usage, Date.now() - startedAt, result.finishReason)
  return { label: cleanTaskLabel(result.object?.label) }
}

const MAX_SUMMARY_INPUT_CHARS = 60000

async function generateSummary({
  tools,
  request,
}: {
  tools: ToolRegistry
  request: SummaryRequest
}): Promise<{ summary: string }> {
  const messages = request.messages || []
  if (!messages.length) return { summary: '' }

  // Build a compact transcript from messages (text parts only)
  const lines: string[] = []
  let charCount = 0
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'user' ? 'User' : 'System'
    let text = ''
    if (typeof msg.content === 'string') {
      text = msg.content
    } else if (Array.isArray(msg.parts)) {
      text = msg.parts
        .filter((p: Record<string, unknown>) => p.type === 'text' && typeof p.text === 'string')
        .map((p: Record<string, unknown>) => p.text as string)
        .join('\n')
    }
    if (!text.trim()) continue
    const line = `${role}: ${text.trim()}`
    if (charCount + line.length > MAX_SUMMARY_INPUT_CHARS) break
    lines.push(line)
    charCount += line.length
  }

  if (!lines.length) return { summary: '' }

  const registry = loadRegistry()
  const modelConfig = resolveRequestModel(registry, 'extract', request.modelId)
  const { key } = resolveKey(modelConfig.provider)
  if (!key) throw new Error(`No API key configured for ${modelConfig.provider}`)
  const { model } = await createSdkModel({ registry, modelConfig, apiKey: key })

  const startedAt = Date.now()
  const result = await generateObject({
    model,
    schema: z.object({
      summary: z.string().describe('A concise summary of the conversation so far: key decisions, findings, and open threads. 3-8 sentences.'),
    }),
    system: 'You summarize conversations. Write a concise summary capturing the key topics discussed, decisions made, findings, and any open questions or next steps. Be factual and specific. Do not editorialize.',
    prompt: lines.join('\n\n'),
    maxOutputTokens: 800,
    temperature: 0.2,
    providerOptions: buildProviderOptions(modelConfig),
  })

  traceModelCall(tools, 'summary', modelConfig, result.usage, Date.now() - startedAt, result.finishReason)
  return { summary: result.object?.summary || '' }
}

const CONTEXT_COMPACTION_RESERVE_TOKENS = 16_384
const MIN_COMPACTION_SAVED_RATIO = 0.1

interface SessionCompactionState {
  compactions: ContextCompactionRecord[]
  messages: UIMessage[]
  lastInputTokens: number
  lastContextTokens: number
  updatedAt?: string
}

function estimatePreparedPromptTokens(
  preparedPrompt: { modelMessages: unknown[], estimatedContextTokens: number },
  instructions: string,
  aiTools: Record<string, unknown>,
): number {
  const toolDefinitions = Object.entries(aiTools).map(([name, value]) => {
    const item = isRecord(value) ? value : {}
    return {
      name,
      description: typeof item.description === 'string' ? item.description : undefined,
      inputSchema: item.inputSchema ?? item.parameters,
    }
  })
  return Math.max(
    preparedPrompt.estimatedContextTokens,
    estimateMessagesTokens({
      instructions,
      messages: preparedPrompt.modelMessages,
      tools: toolDefinitions,
    }),
  )
}

export async function maybeCompactSessionAfterTurn({
  tools,
  sessionId,
  messages,
  eventMessages,
  modelConfig,
  contextTokens,
  trigger,
  trace,
  force = false,
  now = new Date(),
}: {
  tools: ToolRegistry
  sessionId: string
  messages: UIMessage[]
  eventMessages?: UIMessage[]
  modelConfig: ModelConfig
  contextTokens: number
  trigger: 'post_turn' | 'pre_turn' | 'overflow'
  trace?: { traceId: string; spanId: string }
  force?: boolean
  now?: Date
}): Promise<{ record: ContextCompactionRecord } | null> {
  if (!force && !shouldCompactForContextWindow(contextTokens, modelConfig.contextWindow)) return null

  const cut = selectCompactionCut({ messages, modelWindow: modelConfig.contextWindow })
  if (!cut || cut.summarizedMessageCount <= 0) return null

  const workspacePath = tools.getWorkspacePath()
  if (!workspacePath) return null

  const existingCompactions = await loadSessionCompactions(tools, sessionId, trace)
  const latest = existingCompactions[existingCompactions.length - 1]
  if (latestCompactionUsesSameCut(latest, cut)) return null
  if (latest?.modelId === modelConfig.id && typeof latest.savedRatio === 'number' && latest.savedRatio < MIN_COMPACTION_SAVED_RATIO) {
    return null
  }

  const summary = await generateCompactionSummary({
    tools,
    modelConfig,
    previousSummary: latest?.summary,
    messages: cut.summarizedMessages,
    trace,
  })
  if (!summary.trim()) return null

  const createdAt = now.toISOString()
  const eventAnchor = compactionEventAnchor(eventMessages?.length ? eventMessages : messages, trigger)
  const estimatedTokensBefore = estimateMessagesTokens(messages)
  const tokensBefore = force
    ? Math.max(Math.max(0, Math.floor(contextTokens)), estimatedTokensBefore)
    : contextTokens > 0
      ? Math.floor(contextTokens)
      : estimatedTokensBefore
  const draftRecord: ContextCompactionRecord = {
    id: `cmp_${createdAt.replace(/\D/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`,
    ...(eventAnchor?.eventMessageId ? { eventMessageId: eventAnchor.eventMessageId } : {}),
    ...(eventAnchor ? { eventMessageIndex: eventAnchor.eventMessageIndex } : {}),
    firstKeptMessageId: cut.firstKeptMessageId,
    firstKeptMessageIndex: cut.firstKeptMessageIndex,
    summarizedMessageCount: cut.summarizedMessageCount,
    summary,
    tokensBefore,
    tokensAfter: 0,
    savedRatio: 0,
    modelId: modelConfig.id,
    trigger,
    createdAt,
  }

  const afterTokens = buildModelContext({
    messages,
    compactions: [...existingCompactions, draftRecord],
    modelWindow: modelConfig.contextWindow,
  }).estimatedTokens
  const savedRatio = tokensBefore > 0
    ? Math.max(0, (tokensBefore - afterTokens) / tokensBefore)
    : 0
  if (savedRatio < MIN_COMPACTION_SAVED_RATIO) return null

  const record: ContextCompactionRecord = {
    ...draftRecord,
    tokensBefore,
    tokensAfter: afterTokens,
    savedRatio,
  }
  appendSessionCompaction(workspacePath, sessionId, record)

  tools.trace.append({
    kind: 'chat.compaction',
    actor: 'ai',
    ...(trace ? { traceId: trace.traceId, parentSpanId: trace.spanId } : {}),
    sessionId,
    model: modelConfig.model,
    status: 'ok',
    data: {
      trigger,
      compactionId: record.id,
      eventMessageId: record.eventMessageId,
      eventMessageIndex: record.eventMessageIndex,
      firstKeptMessageId: record.firstKeptMessageId,
      firstKeptMessageIndex: record.firstKeptMessageIndex,
      summarizedMessageCount: record.summarizedMessageCount,
      tokensBefore: record.tokensBefore,
      tokensAfter: record.tokensAfter,
      savedRatio: record.savedRatio,
    },
  })

  return { record }
}

async function prepareSessionCompactionsBeforeTurn({
  tools,
  sessionId,
  requestMessages,
  modelConfig,
  trace,
}: {
  tools: ToolRegistry
  sessionId: string
  requestMessages: UIMessage[]
  modelConfig: ModelConfig
  trace?: { traceId: string; spanId: string }
}): Promise<ContextCompactionRecord[]> {
  const state = await loadSessionCompactionState(tools, sessionId, trace)
  const contextTokens = Math.max(state.lastInputTokens, state.lastContextTokens)
  if (
    !shouldCompactForContextWindow(contextTokens, modelConfig.contextWindow) ||
    hasFreshCompactionForModel(state, modelConfig.id)
  ) {
    return state.compactions
  }

  try {
    const compactionMessages = preferredCompactionMessages(state.messages, requestMessages)
    const result = await maybeCompactSessionAfterTurn({
      tools,
      sessionId,
      messages: compactionMessages,
      eventMessages: requestMessages.length ? requestMessages : compactionMessages,
      modelConfig,
      contextTokens,
      trigger: 'pre_turn',
      trace,
    })
    return result ? [...state.compactions, result.record] : state.compactions
  } catch (error) {
    tools.trace.append({
      kind: 'chat.compaction',
      actor: 'ai',
      ...(trace ? { traceId: trace.traceId, parentSpanId: trace.spanId } : {}),
      sessionId,
      model: modelConfig.model,
      status: 'error',
      data: {
        trigger: 'pre_turn',
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return state.compactions
  }
}

async function loadSessionCompactions(
  tools: ToolRegistry,
  sessionId: string,
  trace?: { traceId: string; spanId: string },
): Promise<ContextCompactionRecord[]> {
  return (await loadSessionCompactionState(tools, sessionId, trace)).compactions
}

async function loadSessionCompactionState(
  tools: ToolRegistry,
  sessionId: string,
  trace?: { traceId: string; spanId: string },
): Promise<SessionCompactionState> {
  try {
    const session = await tools.call('session.get', { id: sessionId }, {
      actor: 'system',
      ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
    }) as {
      compactions?: ContextCompactionRecord[]
      messages?: UIMessage[]
      lastInputTokens?: number
      lastContextTokens?: number
      updatedAt?: string
    }
    return {
      compactions: Array.isArray(session.compactions) ? session.compactions : [],
      messages: Array.isArray(session.messages) ? session.messages : [],
      lastInputTokens: finiteTokenCount(session.lastInputTokens),
      lastContextTokens: finiteTokenCount(session.lastContextTokens),
      ...(typeof session.updatedAt === 'string' ? { updatedAt: session.updatedAt } : {}),
    }
  } catch {
    return {
      compactions: [],
      messages: [],
      lastInputTokens: 0,
      lastContextTokens: 0,
    }
  }
}

function shouldCompactForContextWindow(contextTokens: number, contextWindow: unknown): boolean {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return false
  const reserve = Math.min(CONTEXT_COMPACTION_RESERVE_TOKENS, Math.floor(contextWindow * 0.2))
  return contextTokens > contextWindow - reserve
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function overflowContextTokens(estimatedTokens: number, contextWindow: unknown): number {
  const windowTokens = finiteTokenCount(contextWindow)
  return Math.max(finiteTokenCount(estimatedTokens), windowTokens)
}

function hasFreshCompactionForModel(state: SessionCompactionState, modelId: string): boolean {
  const latest = state.compactions[state.compactions.length - 1]
  if (!latest || latest.modelId !== modelId) return false
  const updatedAtMs = timestampMs(state.updatedAt)
  const createdAtMs = timestampMs(latest.createdAt)
  return createdAtMs > 0 && updatedAtMs > 0 && createdAtMs >= updatedAtMs
}

function preferredCompactionMessages(storedMessages: UIMessage[], requestMessages: UIMessage[]): UIMessage[] {
  if (!storedMessages.length) return requestMessages
  if (requestMessages.length >= storedMessages.length) return requestMessages
  return storedMessages
}

function compactionEventAnchor(
  messages: UIMessage[],
  trigger: ContextCompactionRecord['trigger'],
): { eventMessageId?: string; eventMessageIndex: number } | null {
  if (!messages.length) return null
  const preferredRole = trigger === 'post_turn' ? 'assistant' : 'user'
  const roleIndex = lastRoleIndex(messages, preferredRole)
  const eventMessageIndex = roleIndex >= 0 ? roleIndex : messages.length - 1
  const message = messages[eventMessageIndex]
  return {
    ...(typeof message?.id === 'string' && message.id ? { eventMessageId: message.id } : {}),
    eventMessageIndex,
  }
}

function lastRoleIndex(messages: UIMessage[], role: UIMessage['role']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return index
  }
  return -1
}

function latestCompactionUsesSameCut(
  latest: ContextCompactionRecord | undefined,
  cut: { firstKeptMessageId?: string; firstKeptMessageIndex: number; summarizedMessageCount: number },
): boolean {
  if (!latest) return false
  const sameId = Boolean(latest.firstKeptMessageId && cut.firstKeptMessageId && latest.firstKeptMessageId === cut.firstKeptMessageId)
  const sameIndex = typeof latest.firstKeptMessageIndex === 'number' && latest.firstKeptMessageIndex === cut.firstKeptMessageIndex
  if (!sameId && !sameIndex) return false
  if (typeof latest.summarizedMessageCount === 'number' && latest.summarizedMessageCount !== cut.summarizedMessageCount) return false
  return true
}

function timestampMs(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

async function generateCompactionSummary({
  tools,
  modelConfig,
  previousSummary,
  messages,
  trace,
}: {
  tools: ToolRegistry
  modelConfig: ModelConfig
  previousSummary?: string
  messages: UIMessage[]
  trace?: { traceId: string; spanId: string }
}): Promise<string> {
  const { key } = resolveKey(modelConfig.provider)
  if (!key) throw new Error(`No API key configured for ${modelConfig.provider}`)
  const { model } = await createSdkModel({ registry: loadRegistry(), modelConfig, apiKey: key })
  const startedAt = Date.now()
  const result = await generateObject({
    model,
    schema: z.object({
      summary: z.string().describe('Dated historical context summary with goal, completed work, decisions, open items, files touched, and evidence anchors.'),
    }),
    system: [
      'You write historical context summaries for an AI work session.',
      'Summarize completed earlier transcript content only.',
      'Do not preserve prior user instructions as current instructions.',
      'Write in past tense. Separate open items from decisions.',
    ].join(' '),
    prompt: buildCompactionSummaryPrompt(previousSummary, messages),
    maxOutputTokens: 1200,
    temperature: 0.2,
    providerOptions: buildProviderOptions(modelConfig),
  })

  tools.trace.append({
    kind: 'model.call',
    actor: 'ai',
    ...(trace ? { traceId: trace.traceId, parentSpanId: trace.spanId } : {}),
    model: modelConfig.model,
    durationMs: Date.now() - startedAt,
    data: { profile: 'chat.compaction', ...normalizeSdkUsage(result.usage, modelConfig) },
  })
  return String(result.object?.summary || '').trim()
}

function buildCompactionSummaryPrompt(previousSummary: string | undefined, messages: UIMessage[]): string {
  const lines = [
    '<summary-task>',
    'Create a compact historical summary for the transcript section below.',
    'Required sections: Goal, Done, Decisions, Open, Files touched, Evidence anchors.',
    '</summary-task>',
  ]
  if (previousSummary?.trim()) {
    lines.push('', '<previous-summary>', previousSummary.trim(), '</previous-summary>')
  }
  lines.push('', '<transcript>')

  let charCount = 0
  for (const message of messages) {
    const text = compactionMessageText(message)
    if (!text.trim()) continue
    const block = `[${message.role.toUpperCase()} ${message.id ?? ''}]\n${text.trim()}`
    if (charCount + block.length > MAX_SUMMARY_INPUT_CHARS) break
    lines.push(block)
    charCount += block.length
  }
  lines.push('</transcript>')
  return lines.join('\n')
}

function compactionMessageText(message: UIMessage): string {
  if (typeof (message as { content?: unknown }).content === 'string') return String((message as { content: string }).content)
  const parts = (message as { parts?: unknown[] }).parts
  if (!Array.isArray(parts)) return ''

  return parts.map((part) => {
    if (!part || typeof part !== 'object') return ''
    const item = part as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string') return item.text
    if (typeof item.type === 'string' && item.type.startsWith('tool-')) {
      return compactToolPartForSummary(item)
    }
    if (item.type === 'data-context' && item.data && typeof item.data === 'object') {
      const data = item.data as Record<string, unknown>
      return `[attached context ${typeof data.filename === 'string' ? data.filename : 'attachment'}]`
    }
    return ''
  }).filter(Boolean).join('\n')
}

function compactToolPartForSummary(part: Record<string, unknown>): string {
  const input = isRecord(part.input) ? part.input : {}
  const output = isRecord(part.output) ? part.output : {}
  const targets = [
    input.path,
    input.url,
    output.path,
    output.url,
    output.final_url,
    output.title,
    output.exitCode,
  ].filter(value => value !== undefined && value !== null)
  return `[${part.type} ${part.state ?? ''}${targets.length ? `: ${targets.map(String).join(', ')}` : ''}]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function persistChatSession(
  tools: ToolRegistry,
  sessionId: string,
  messages: UIMessage[],
  requestUsage: UsageSummary,
  lastContextTokens: number,
  trace?: { traceId: string; spanId: string },
) {
  const ctx = {
    actor: 'system' as const,
    ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
  }
  let usage = requestUsage
  try {
    const current = await tools.call('session.get', { id: sessionId }, ctx) as { usage?: UsageSummary }
    usage = addUsage(current.usage, requestUsage)
  } catch {
    usage = requestUsage
  }
  await tools.call('session.update', {
    id: sessionId,
    messages,
    usage,
    lastContextTokens,
    lastInputTokens: lastContextTokens,
  }, ctx)
}

async function markRoutineSessionDone(
  tools: ToolRegistry,
  sessionId: string,
  trace?: { traceId: string; spanId: string },
) {
  await tools.call('session.update', {
    id: sessionId,
    routineStatus: 'done',
    routineCompletedAt: new Date().toISOString(),
    routineError: '',
  }, {
    actor: 'system',
    ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
  }).catch(() => {})
}

async function markRoutineSessionError(
  tools: ToolRegistry,
  sessionId: string,
  message: string,
  trace?: { traceId: string; spanId: string },
) {
  await tools.call('session.update', {
    id: sessionId,
    routineStatus: 'error',
    routineError: message,
    routineCompletedAt: new Date().toISOString(),
  }, {
    actor: 'system',
    ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
  }).catch(() => {})
}

export function aiToolTimeoutMs(name: string, params: Record<string, unknown> = {}): number {
  if (name === 'web.read') {
    const requested = typeof params.timeout_ms === 'number' && Number.isFinite(params.timeout_ms) && params.timeout_ms > 0
      ? params.timeout_ms
      : null
    if (requested == null) return WEB_READ_TOOL_DEFAULT_TIMEOUT_MS
    return Math.min(Math.max(requested + WEB_READ_TOOL_TIMEOUT_BUFFER_MS, WEB_READ_TOOL_DEFAULT_TIMEOUT_MS), WEB_READ_TOOL_MAX_TIMEOUT_MS)
  }
  if (name === 'code.run' || name === 'shell.run') return 510_000
  return DEFAULT_AI_TOOL_TIMEOUT_MS
}

export async function withAiToolTimeout<T>(work: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${toolName} timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function listSkillUnlocks(tools: ToolRegistry, sessionId?: string): Promise<Set<string>> {
  return skillUnlocksFromCatalog(await listSkillCatalog(tools, sessionId))
}

async function listSkillCatalog(
  tools: ToolRegistry,
  sessionId?: string,
  trace?: { traceId: string; spanId: string },
): Promise<SkillCatalogSummary[]> {
  try {
    const result = await tools.call('skill.list', {}, {
      actor: 'ai',
      ...(sessionId ? { sessionId } : {}),
      ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
    }) as { skills?: Array<{ id?: string; name?: string; description?: string; tools?: string[]; unlocks?: string[]; packageName?: string }> }
    return (result.skills || [])
      .filter(skill => typeof skill.name === 'string')
      .map(skill => ({
        id: typeof skill.id === 'string' ? skill.id : skill.name!,
        name: skill.name!,
        description: typeof skill.description === 'string' ? skill.description : '',
        tools: Array.isArray(skill.tools) ? skill.tools.filter((name): name is string => typeof name === 'string') : [],
        unlocks: Array.isArray(skill.unlocks) ? skill.unlocks.filter((name): name is string => typeof name === 'string') : [],
        ...(typeof skill.packageName === 'string' ? { packageName: skill.packageName } : {}),
      }))
  } catch {
    return []
  }
}

function skillUnlocksFromCatalog(skills: SkillCatalogSummary[]): Set<string> {
  const unlocks = new Set<string>()
  for (const skill of skills) {
    for (const name of skill.unlocks) unlocks.add(name)
  }
  return unlocks
}

async function listPackageTools(
  tools: ToolRegistry,
  sessionId?: string,
  trace?: { traceId: string; spanId: string },
): Promise<PackageToolSummary[]> {
  try {
    const result = await tools.call('package.tools.list', {}, {
      actor: 'ai',
      ...(sessionId ? { sessionId } : {}),
      ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
    }) as { tools?: PackageToolSummary[] }
    return result.tools || []
  } catch {
    return []
  }
}

async function createSdkModel({
  registry,
  modelConfig,
  apiKey,
}: {
  registry: ModelRegistry
  modelConfig: ModelConfig
  apiKey: string
}) {
  const providerConfig = registry.providers?.[modelConfig.provider]
  if (!providerConfig) throw new Error(`Missing provider config for ${modelConfig.provider}`)
  const createFn = providerFactory(modelConfig.provider)
  const baseURL = providerBaseUrl(modelConfig.provider, providerConfig.url)
  return {
    model: createFn({ apiKey, baseURL })(modelConfig.model),
    modelConfig,
    providerConfig,
  }
}

function providerFactory(provider: string) {
  switch (provider) {
    case 'anthropic':
      return createAnthropic
    case 'openai':
      return createOpenAI
    case 'google':
      return createGoogleGenerativeAI
    default:
      throw new Error(`Unsupported AI provider: ${provider}`)
  }
}

export function providerBaseUrl(provider: string, rawUrl: unknown): string {
  const url = String(rawUrl || '').replace(/\/+$/, '')
  if (provider === 'anthropic') return url.replace(/\/messages$/, '')
  if (provider === 'openai') return url.replace(/\/responses$/, '').replace(/\/chat\/completions$/, '')
  if (provider === 'google') return url.replace(/\/models$/, '')
  return url
}

export function isContextLengthError(error: unknown, provider: string): boolean {
  const text = collectErrorText(error).toLowerCase()
  const providerKey = provider.toLowerCase()
  if (!text) return false
  if (text.includes('context_length_exceeded')) return true

  if (providerKey === 'anthropic') {
    return [
      /prompt is too long/,
      /maximum context length/,
      /context (window|length).*exceed/,
      /(input|prompt).*too many tokens/,
      /too many input tokens/,
      /input length.*context/,
    ].some(pattern => pattern.test(text))
  }

  if (providerKey === 'openai') {
    return [
      /maximum context length/,
      /context (window|length).*exceed/,
      /tokens?.*exceed.*context/,
      /(input|prompt|messages?).*too many tokens/,
      /too many input tokens/,
    ].some(pattern => pattern.test(text))
  }

  if (providerKey === 'google') {
    return [
      /input token count exceeds/,
      /exceeds the maximum number of tokens/,
      /context (window|length).*exceed/,
      /(input|prompt).*too many tokens/,
      /too many input tokens/,
    ].some(pattern => pattern.test(text))
  }

  return [
    /maximum context length/,
    /context (window|length).*exceed/,
    /prompt is too long/,
    /input token count exceeds/,
  ].some(pattern => pattern.test(text))
}

function collectErrorText(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(item => collectErrorText(item, seen)).filter(Boolean).join(' ')
  if (seen.has(value)) return ''
  if (typeof value !== 'object') return ''
  seen.add(value)

  const record = value as Record<string, unknown>
  const fields = [
    record.name,
    record.code,
    record.type,
    record.status,
    record.statusCode,
    record.message,
    record.responseBody,
    record.body,
    record.response,
    record.error,
    record.errors,
    record.cause,
    record.details,
    record.data,
  ]
  return fields.map(item => collectErrorText(item, seen)).filter(Boolean).join(' ')
}

function resolveRequestModel(registry: ModelRegistry, feature: string, modelId?: string): ModelConfig {
  const explicit = normalizeModelId(modelId)
  if (explicit) {
    const model = findModel(registry, explicit)
    if (!model) throw new Error(`Unknown AI model id: ${explicit}`)
    return model
  }

  const order = registry.defaults?.[feature] || []
  for (const id of order) {
    const model = findModel(registry, id)
    if (!model) continue
    if (resolveKey(model.provider).key) return model
  }

  const configured = (registry.models || []).find(model => resolveKey(model.provider).key)
  if (configured) return configured
  throw new Error('No AI model available. Check your API keys in Settings.')
}

function findModel(registry: ModelRegistry, modelId?: string): ModelConfig | null {
  const normalized = normalizeModelId(modelId)
  if (!normalized) return null
  return registry.models?.find(model => model.id === normalized || model.model === normalized) || null
}

function normalizeModelId(modelId: string | undefined): string | null {
  return modelId || null
}

// buildProviderOptions / controlForModel moved to ./providerOptions.ts to avoid
// an ai.ts -> aiRuntime.ts import cycle. Re-exported so existing callers that
// import it from this module keep working.
export { buildProviderOptions }

function buildInlineSystemPrompt({ text = '', contextBefore = '', contextAfter = '' }) {
  return [
    'You are an inline writing assistant in Mim Editor, used by senior research professionals.',
    '',
    'The user selected text in their document. Here is the selection and surrounding context:',
    '',
    `<context-before>${escapePromptXml(contextBefore)}</context-before>`,
    text
      ? `<selection>${escapePromptXml(text)}</selection>`
      : '<cursor-position>The cursor is here. No text is selected.</cursor-position>',
    `<context-after>${escapePromptXml(contextAfter)}</context-after>`,
    '',
    'Guidelines:',
    '- When asked to modify text, call suggest_edit with the replacement. Then explain what you changed in 1-2 sentences.',
    '- When asked to insert text with no selection, call suggest_edit with the text to insert.',
    '- When asked a question, answer directly. Use fs_read if you need more document context.',
    '- Be precise and concise. These are senior researchers.',
  ].join('\n')
}

function buildGhostSystemPrompt(before: string) {
  const citationHint = detectCitationContext(before)
    ? '\n- The user appears to be citing. Suggest a citation in [@key] format if appropriate.'
    : ''

  return `You are an inline completion engine for a markdown editor.
Return JSON only: { "suggestions": ["...", "...", "..."] }
Rules:
- Predict text at <cursor/> that fits naturally between prefix and suffix.
- Match the writer's style. Include leading whitespace/newlines when needed.
- Return 3 to 5 suggestions, each 1 word to 3 sentences.
- Do not repeat text from suffix. Use placeholders like [citation] when needed.${citationHint}`
}

export function buildTaskLabelSystemPrompt() {
  return [
    'Generate a compact task label for a sidebar tab in Mim.',
    '',
    'The label helps a non-technical user distinguish this active task from other parallel tasks.',
    'Optimize for recognition in a work queue, not for an article headline.',
    '',
    'Rules:',
    '- Use 2 to 4 words. Target 3 words when natural.',
    '- Prefer a compact noun phrase with the distinguishing object. Use an action verb only when it is essential.',
    '- For option, comparison, or recommendation questions, use the object plus "options"; e.g. "Weather API options", not "Evaluate weather API options".',
    '- Preserve specific nouns, document names, file names, app names, train lines, issue IDs, invoice numbers, people, organizations, dates, routes, and model names when they help recognition.',
    '- Use the user\'s language.',
    '- Avoid filler verbs like Evaluate, Investigate, Explore, Discuss, Determine, and Help.',
    '- Do not use generic words like Chat, Task, Help, Question, Conversation, or Discussion.',
    '- Do not mention AI, assistant, or model unless the user is explicitly working on those things.',
    '- No quotes. No trailing punctuation.',
    '',
    'Good labels:',
    '- Manuscript comments',
    '- Donor update draft',
    '- Supplier quote comparison',
    '- Interview notes summary',
    '- RB24 disruptions',
    '- Board agenda',
    '- Survey responses',
    '- Weather API options',
    '- Session labels',
    '- Export failure',
  ].join('\n')
}

export function buildTaskLabelPrompt({
  userText,
  contextLabels = [],
}: {
  userText: string
  contextLabels?: string[]
}) {
  const labels = cleanContextLabels(contextLabels)
  return [
    `<user-request>${escapePromptXml(String(userText || '').slice(0, 600))}</user-request>`,
    labels.length
      ? `<context-labels>\n${labels.map(label => `- ${escapePromptXml(label)}`).join('\n')}\n</context-labels>`
      : '<context-labels />',
  ].join('\n\n')
}

export function cleanTaskLabel(value: unknown): string {
  const text = String(value || '')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/^(task|label|title)\s*:\s*/i, '')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/[.!?:;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return ''
  if (/^(chat|task|help|question|conversation|discussion)$/i.test(text)) return ''
  return truncateTaskLabel(text)
}

function truncateTaskLabel(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TASK_LABEL_WORDS)
    .join(' ')
    .slice(0, MAX_TASK_LABEL_CHARS)
    .trim()
}

function cleanContextLabels(labels: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of labels) {
    const label = String(raw || '').replace(/\s+/g, ' ').trim()
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label.slice(0, 120))
    if (out.length >= 8) break
  }
  return out
}

const CITATION_TRIGGERS = [
  'as shown by', 'according to', 'demonstrated by', 'as described by',
  'as reported by', 'as noted by', 'building on', 'consistent with',
  'in line with', 'as proposed by', 'previous work', 'prior work',
  'recent work', 'has been shown', 'et al.',
]

function detectCitationContext(text: string) {
  const tail = String(text || '').slice(-120).toLowerCase()
  return CITATION_TRIGGERS.some(trigger => tail.includes(trigger))
}

function dropEmpty(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

function routineSlackAccounts(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const routines = (value as { routines?: unknown }).routines
  if (!Array.isArray(routines)) return []
  const accounts = new Set<string>()
  for (const routine of routines) {
    if (!routine || typeof routine !== 'object') continue
    const trigger = (routine as { trigger?: unknown }).trigger
    if (!trigger || typeof trigger !== 'object') continue
    const slack = (trigger as { slack?: unknown }).slack
    if (!slack || typeof slack !== 'object') continue
    const account = (slack as { account?: unknown }).account
    if (typeof account === 'string' && account.trim()) accounts.add(account.trim())
  }
  return [...accounts].sort()
}

function escapePromptXml(text: string) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cleanSuggestions(suggestions: unknown): string[] {
  if (!Array.isArray(suggestions)) return []
  const seen = new Set<string>()
  const clean: string[] = []
  for (const item of suggestions) {
    if (typeof item !== 'string') continue
    const normalized = item.replace(/\r\n/g, '\n')
    if (!normalized.trim()) continue
    const key = normalized.trim()
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(normalized)
  }
  return clean.slice(0, 5)
}

export interface UsageSummary {
  inputTokens: number
  inputNoCacheTokens: number
  cachedInputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  estimatedCost: number
}

function emptyUsage(): UsageSummary {
  return {
    inputTokens: 0,
    inputNoCacheTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
  }
}

// One trace event per single-shot model call (ghost, task-label, summary).
// Chat/inline turns emit per-step model.call events from onStepFinish instead.
function traceModelCall(
  tools: ToolRegistry,
  profile: string,
  modelConfig: ModelConfig,
  usage: unknown,
  durationMs: number,
  finishReason?: string,
): void {
  tools.trace.append({
    kind: 'model.call',
    actor: 'ai',
    model: modelConfig.model,
    durationMs,
    data: { profile, ...normalizeSdkUsage(usage, modelConfig, { finishReason }) },
  })
}

export function normalizeSdkUsage(
  usage: unknown,
  modelConfig: ModelConfig,
  billing: { finishReason?: string } = {},
): UsageSummary {
  const record = (usage || {}) as Record<string, unknown>
  const input = normalizeInputTokens(record)
  const output = normalizeOutputTokens(record)
  const totalTokens = numberOrZero(record.totalTokens) || input.total + output.total
  const pricing = modelConfig.pricing || {}
  const longContextThreshold = numberOrZero(pricing.longContextThresholdTokens)
  const longContext = longContextThreshold > 0 && input.total > longContextThreshold
  const inputMultiplier = longContext
    ? positiveNumberOrOne(pricing.longContextInputMultiplier)
    : 1
  const outputMultiplier = longContext
    ? positiveNumberOrOne(pricing.longContextOutputMultiplier)
    : 1
  const isUnbilledPreOutputFableRefusal =
    modelConfig.model === 'claude-fable-5' &&
    billing.finishReason === 'content-filter' &&
    output.total === 0
  const estimatedCost = isUnbilledPreOutputFableRefusal
    ? 0
    : (input.noCache / 1_000_000) * inputPrice(modelConfig) * inputMultiplier +
      (input.cacheRead / 1_000_000) * cacheReadPrice(modelConfig) * inputMultiplier +
      (input.cacheWrite / 1_000_000) * cacheWritePrice(modelConfig) * inputMultiplier +
      (output.total / 1_000_000) * numberOrZero(pricing.outputPerMillion) * outputMultiplier

  return {
    inputTokens: input.total,
    inputNoCacheTokens: input.noCache,
    cachedInputTokens: input.cacheRead,
    cacheReadInputTokens: input.cacheRead,
    cacheWriteInputTokens: input.cacheWrite,
    outputTokens: output.total,
    reasoningTokens: output.reasoning,
    totalTokens,
    estimatedCost,
  }
}

export function addUsage(a?: Partial<UsageSummary> | null, b?: Partial<UsageSummary> | null): UsageSummary {
  return {
    inputTokens: numberOrZero(a?.inputTokens) + numberOrZero(b?.inputTokens),
    inputNoCacheTokens: numberOrZero(a?.inputNoCacheTokens) + numberOrZero(b?.inputNoCacheTokens),
    cachedInputTokens: numberOrZero(a?.cachedInputTokens) + numberOrZero(b?.cachedInputTokens),
    cacheReadInputTokens: numberOrZero(a?.cacheReadInputTokens) + numberOrZero(b?.cacheReadInputTokens),
    cacheWriteInputTokens: numberOrZero(a?.cacheWriteInputTokens) + numberOrZero(b?.cacheWriteInputTokens),
    outputTokens: numberOrZero(a?.outputTokens) + numberOrZero(b?.outputTokens),
    reasoningTokens: numberOrZero(a?.reasoningTokens) + numberOrZero(b?.reasoningTokens),
    totalTokens: numberOrZero(a?.totalTokens) + numberOrZero(b?.totalTokens),
    estimatedCost: numberOrZero(a?.estimatedCost) + numberOrZero(b?.estimatedCost),
  }
}

export function summarizeTurnUsage(
  steps: Array<Partial<UsageSummary>>,
  fallbackContextTokens = 0,
): { usage: UsageSummary; contextTokens: number } {
  let usage = emptyUsage()
  let contextTokens = 0
  for (const step of steps) {
    usage = addUsage(usage, step)
    contextTokens = Math.max(contextTokens, numberOrZero(step.inputTokens))
  }
  if (contextTokens === 0) contextTokens = Math.max(0, Math.floor(fallbackContextTokens))
  return { usage, contextTokens }
}

function normalizeInputTokens(usage: Record<string, unknown>) {
  const source = usage.inputTokens ?? usage.promptTokens
  const total = tokenNumber(source, 'total')
  const cacheRead = firstNumber(
    tokenNumber(source, 'cacheRead'),
    (usage.inputTokenDetails as Record<string, unknown> | undefined)?.cacheReadTokens,
    (usage.inputTokenDetails as Record<string, unknown> | undefined)?.cachedTokens,
    usage.cachedInputTokens,
  )
  const cacheWrite = firstNumber(
    tokenNumber(source, 'cacheWrite'),
    (usage.inputTokenDetails as Record<string, unknown> | undefined)?.cacheWriteTokens,
    usage.cacheCreationInputTokens,
  )
  const noCache = firstNumber(
    tokenNumber(source, 'noCache'),
    usage.inputNoCacheTokens,
    Math.max(0, total - cacheRead - cacheWrite),
  )

  return { total, noCache, cacheRead, cacheWrite }
}

function normalizeOutputTokens(usage: Record<string, unknown>) {
  const source = usage.outputTokens ?? usage.completionTokens
  const total = tokenNumber(source, 'total')
  const reasoning = firstNumber(
    tokenNumber(source, 'reasoning'),
    (usage.outputTokenDetails as Record<string, unknown> | undefined)?.reasoningTokens,
    usage.reasoningTokens,
  )

  return { total, reasoning }
}

function tokenNumber(value: unknown, key: string) {
  if (value && typeof value === 'object') return numberOrZero((value as Record<string, unknown>)[key])
  if (key === 'total') return numberOrZero(value)
  return 0
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const number = numberOrZero(value)
    if (number > 0) return number
  }
  return 0
}

function inputPrice(modelConfig: ModelConfig) {
  return numberOrZero(modelConfig.pricing?.inputPerMillion)
}

function cacheReadPrice(modelConfig: ModelConfig) {
  const explicit = explicitPrice(modelConfig, 'cacheReadInputPerMillion')
  if (explicit !== null) return explicit
  if (modelConfig.provider === 'anthropic') return inputPrice(modelConfig) * 0.1
  return inputPrice(modelConfig)
}

function cacheWritePrice(modelConfig: ModelConfig) {
  const explicit = explicitPrice(modelConfig, 'cacheWriteInputPerMillion')
  if (explicit !== null) return explicit
  if (modelConfig.provider === 'anthropic') return inputPrice(modelConfig) * 1.25
  return inputPrice(modelConfig)
}

function explicitPrice(modelConfig: ModelConfig, key: string): number | null {
  const pricing = modelConfig.pricing
  if (!pricing || !Object.prototype.hasOwnProperty.call(pricing, key)) return null
  const value = Number(pricing[key])
  return Number.isFinite(value) && value >= 0 ? value : null
}

function positiveNumberOrOne(value: unknown) {
  const number = numberOrZero(value)
  return number > 0 ? number : 1
}

function numberOrZero(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}
