<script setup lang="ts">
// Work surface for one agent session (the run grammar around a terminal):
// live TerminalSurface while the pty runs, scrollback replay with an
// end-state banner once it ends. Session data comes from the runs store;
// only identity arrives via props.
import { IconAlertTriangle, IconArchive, IconPlayerPlay } from '@tabler/icons-vue'
import { computed, ref, watch } from 'vue'
import TerminalSurface from '../terminal/TerminalSurface.vue'
import type { TerminalKeybindingProfile } from '../terminal/terminalKeybindings.js'
import { useAgentsStore } from '../../stores/agents.js'
import { useRunsStore, type AgentSessionRuntime } from '../../stores/runs.js'

const props = defineProps<{
  agentId: string
  sessionId: string
}>()

const emit = defineEmits<{
  openAgentSession: [agentId: string, sessionId: string]
  archiveAgentSession: [sessionId: string]
}>()

const runsStore = useRunsStore()
const agentsStore = useAgentsStore()

const session = computed<AgentSessionRuntime | null>(() =>
  runsStore.agentSessions.find(item => item.sessionId === props.sessionId) ?? null
)
const effectiveAgentId = computed(() => session.value?.agentId ?? props.agentId)
const agentName = computed(() =>
  agentsStore.agents.find(agent => agent.id === effectiveAgentId.value)?.name ?? effectiveAgentId.value
)
const keybindingProfile = computed<TerminalKeybindingProfile>(() => {
  const agentId = effectiveAgentId.value
  if (agentId === 'claude-code' || agentId === 'gemini-cli' || agentId === 'codex' || agentId === 'pi') {
    return agentId
  }
  return 'terminal'
})
const running = computed(() => session.value?.status === 'running')
const ended = computed(() => !!session.value && session.value.status !== 'running')

const statusLabel = computed(() => {
  const current = session.value
  if (!current) return 'Missing'
  if (current.status === 'running') {
    if (current.runtimeStatus === 'idle') return 'Idle'
    if (current.runtimeStatus === 'done') return 'Done'
    if (current.runtimeStatus === 'needs-input') return 'Needs input'
    return 'Working'
  }
  if (current.status === 'done') return 'Done'
  if (current.status === 'error') return 'Failed'
  if (current.status === 'stopped') return 'Stopped'
  return 'Stopped'
})

const statusClass = computed(() => {
  const current = session.value
  if (!current) return 'border-rule text-ink-3 bg-chrome-high'
  if (current.status === 'running' && current.runtimeStatus === 'idle') return 'border-rule text-ink-3 bg-chrome-mid'
  if (current.status === 'running' && current.runtimeStatus === 'done') return 'border-add/25 text-add bg-add/8'
  if (current.status === 'running') return 'border-accent/25 text-accent bg-accent-tint'
  if (current.status === 'done') return 'border-add/25 text-add bg-add/8'
  if (current.status === 'stopped') return 'border-rule text-ink-3 bg-chrome-mid'
  if (current.status === 'interrupted') return 'border-rule text-ink-3 bg-chrome-mid'
  return 'border-rem/25 text-rem bg-rem/8'
})


const bannerText = computed(() => {
  const current = session.value
  if (!current || current.status === 'running') return ''
  if (current.status === 'done') return 'Exited'
  if (current.status === 'error') {
    return current.exitCode != null ? `Failed (exit ${current.exitCode})` : 'Failed'
  }
  if (current.status === 'stopped') return 'Stopped'
  return 'Stopped because Mim was closed while this session ran'
})

const bannerClass = computed(() => {
  const status = session.value?.status
  if (status === 'error') return 'border-rem/20 bg-rem/8 text-rem'
  return 'border-rule-light bg-chrome-high text-ink-2'
})

/* ── Scrollback replay (fetched once per ended session) ── */
const replayText = ref<string | null>(null)
const replayError = ref<string | null>(null)
let fetchedFor: string | null = null

watch([() => props.sessionId, ended], async () => {
  if (!ended.value || fetchedFor === props.sessionId) return
  fetchedFor = props.sessionId
  replayError.value = null
  try {
    const result = await window.kernel.call('agent.sessions.get', {
      sessionId: props.sessionId,
      scrollback: true,
    }) as { session?: AgentSessionRuntime }
    replayText.value = result.session?.scrollback ?? ''
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isMissingSessionError(message, props.sessionId)) {
      replayText.value = null
      replayError.value = null
      runsStore.removeAgentSession(props.sessionId)
      return
    }
    fetchedFor = null
    replayError.value = message
  }
}, { immediate: true })

function isMissingSessionError(message: string, sessionId: string): boolean {
  return message.includes('Agent session not found') && message.includes(sessionId)
}

/* ── Actions ── */
const actionBusy = ref<'resume' | null>(null)
const actionError = ref<string | null>(null)

function archiveSession() {
  if (!session.value || actionBusy.value) return
  actionError.value = null
  emit('archiveAgentSession', props.sessionId)
}

async function resumeSession() {
  if (actionBusy.value) return
  actionBusy.value = 'resume'
  actionError.value = null
  try {
    const result = await window.kernel.call('agent.resume', { sessionId: props.sessionId }) as {
      session?: AgentSessionRuntime
      ptyId?: number
    }
    if (!result.session) throw new Error('Resume did not return a session')
    runsStore.applyAgentSessionEvent({ type: 'session.started', session: result.session })
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionBusy.value = null
  }
}

watch(running, (isRunning) => {
  if (isRunning) {
    fetchedFor = null
    replayText.value = null
  }
})

</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-ink" data-testid="agent-session-view">
    <header class="flex h-10 shrink-0 items-center gap-3 border-b border-rule-light bg-chrome-high px-4">
      <div class="flex min-w-0 flex-1 items-baseline gap-2 truncate">
        <h1 class="truncate font-sans text-[13px] font-semibold leading-tight text-ink">
          {{ session?.title ?? 'Agent session' }}
        </h1>
        <span v-if="session?.titleHint" class="truncate font-sans text-[11px] text-ink-4">{{ session.titleHint }}</span>
      </div>
      <span
        class="shrink-0 rounded-full border px-2 py-[2px] font-sans text-[10px] font-semibold uppercase tracking-[0.04em]"
        :class="statusClass"
      >
        {{ statusLabel }}
      </span>
      <button
        v-if="running"
        class="flex h-6 shrink-0 items-center gap-1 rounded-[5px] border border-rule-light px-2 font-sans text-[11px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink disabled:opacity-50"
        title="Stop and archive session"
        @click="archiveSession"
      >
        <IconArchive :size="12" :stroke-width="2" />
        Archive
      </button>
    </header>

    <div
      v-if="actionError"
      class="mx-4 mt-3 flex items-start gap-2 rounded-[7px] border border-rem/20 bg-rem/8 p-2.5 font-sans text-[12px] text-rem"
    >
      <IconAlertTriangle class="mt-px shrink-0" :size="14" :stroke-width="2.1" />
      <span>{{ actionError }}</span>
    </div>

    <!-- Missing record: the session was deleted or never hydrated. -->
    <div v-if="!session" class="m-4 grid content-start gap-2 rounded-[8px] border border-rule-light bg-chrome-high p-4" role="alert">
      <div class="flex items-center gap-2">
        <IconAlertTriangle class="text-accent" :size="16" :stroke-width="2.1" />
        <h2 class="m-0 font-sans text-[12.5px] font-semibold text-ink">Session not found</h2>
      </div>
      <p class="m-0 font-sans text-[12px] leading-relaxed text-ink-3">
        This agent session is no longer on record — it may have been deleted.
        You can start a new {{ agentName }} session from the Apps section.
      </p>
    </div>

    <!-- Live session: terminal bound to the running pty. -->
    <div v-else-if="running" class="relative min-h-0 flex-1 overflow-hidden bg-surface">
      <div class="absolute inset-y-1 left-2 right-2 overflow-hidden">
        <TerminalSurface :pty-id="session.ptyId ?? null" :keybinding-profile="keybindingProfile" />
      </div>
    </div>

    <!-- Ended session: end-state banner plus scrollback replay. -->
    <template v-else>
      <div
        class="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-[7px] border px-3 py-2 font-sans text-[12px]"
        :class="bannerClass"
      >
        <span class="min-w-0 flex-1 truncate font-semibold">{{ bannerText }}</span>
        <button
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] border border-rule-light bg-surface px-2 font-sans text-[11px] font-semibold text-ink-2 hover:bg-chrome-mid hover:text-ink disabled:opacity-50"
          :disabled="actionBusy === 'resume'"
          title="Resume this session"
          @click="resumeSession"
        >
          <IconPlayerPlay :size="12" :stroke-width="2.2" />
          Resume
        </button>
        <button
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] border border-rule-light bg-surface px-2 font-sans text-[11px] font-semibold text-ink-2 hover:bg-chrome-mid hover:text-ink disabled:opacity-50"
          :disabled="actionBusy === 'resume'"
          title="Archive session"
          @click="archiveSession"
        >
          <IconArchive :size="12" :stroke-width="2" />
          Archive
        </button>
      </div>
      <div class="relative mt-1 min-h-0 flex-1 overflow-hidden bg-surface">
        <div
          v-if="replayError"
          class="m-4 flex items-start gap-2 rounded-[7px] border border-rem/20 bg-rem/8 p-2.5 font-sans text-[12px] text-rem"
        >
          <IconAlertTriangle class="mt-px shrink-0" :size="14" :stroke-width="2.1" />
          <span>Could not load the session scrollback: {{ replayError }}</span>
        </div>
        <div v-else-if="replayText === null" class="flex h-full items-center justify-center font-sans text-[12px] text-ink-3">
          Loading session output
        </div>
        <div v-else class="absolute inset-y-1 left-2 right-2 overflow-hidden">
          <TerminalSurface :replay="replayText" />
        </div>
      </div>
    </template>
  </section>
</template>
