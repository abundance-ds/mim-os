<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingRow from './SettingRow.vue'

interface TeamChange {
  kind: 'app' | 'skill' | 'routine' | 'file' | 'instructions'
  id: string
  name: string
  action: 'added' | 'updated' | 'removed'
  currentVersion?: string
  nextVersion?: string
  accessChanged?: boolean
}

interface TeamStatus {
  state: string
  repository: string | null
  message: string
  team: {
    name: string
    root: string
    contributions: {
      instructions: boolean
      files: number
      skills: number
      apps: number
      routines: number
    }
  } | null
  update: {
    state: 'unknown' | 'current' | 'available'
    changes: TeamChange[]
    checkedAt: string | null
    appliedAt?: string
    recentChanges?: TeamChange[]
    error?: string
  }
  git?: {
    available: boolean
    installAction: string | null
    lfsRequired: boolean
    lfsAvailable: boolean | null
    lfsInstallAction: string | null
  }
}

const status = ref<TeamStatus | null>(null)
const repository = ref('')
const busy = ref<'connect' | 'check' | 'update' | ''>('')
const error = ref('')

const configured = computed(() => Boolean(status.value?.repository))
const connected = computed(() => Boolean(status.value?.repository && status.value.team))
const setupAction = computed(() => status.value?.git?.installAction || status.value?.git?.lfsInstallAction || '')
const updateAvailable = computed(() => status.value?.update.state === 'available')
const accessReview = computed(() => status.value?.update.changes.some(change => change.accessChanged) ?? false)
const displayChanges = computed(() => updateAvailable.value
  ? status.value?.update.changes ?? []
  : status.value?.update.recentChanges ?? [])
const stateTitle = computed(() => {
  if (busy.value === 'update') return 'Updating'
  if (status.value?.state === 'stopped' || status.value?.state === 'invalid') return 'Needs attention'
  if (updateAvailable.value) return 'Update available'
  if (status.value?.update.appliedAt) return 'Updated'
  if (status.value?.update.state === 'unknown' && busy.value === 'check') return 'Checking'
  return 'Up to date'
})
const stateDescription = computed(() => {
  if (busy.value === 'update') return 'Installing your Team’s apps, skills, and shared content.'
  if (status.value?.state === 'stopped' || status.value?.state === 'invalid') return status.value.message
  if (updateAvailable.value) {
    return accessReview.value
      ? 'Review what changed, including any new access, then update when you’re ready.'
      : 'Review what changed, then update when you’re ready.'
  }
  if (status.value?.update.error) return 'You’re using the latest Team version checked on this device.'
  if (status.value?.update.appliedAt) return 'Your Team update is installed.'
  return 'You have the latest Team apps, skills, and shared content.'
})

async function load() {
  error.value = ''
  try {
    status.value = await window.kernel.call('team.status') as TeamStatus
    if (!status.value.repository) return
    busy.value = 'check'
    status.value = await window.kernel.call('team.check', { announce: false }) as TeamStatus
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = ''
  }
}

async function refresh() {
  try {
    status.value = await window.kernel.call('team.status') as TeamStatus
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function connect() {
  if (!repository.value.trim()) return
  busy.value = 'connect'
  error.value = ''
  try {
    status.value = await window.kernel.call('team.connect', { repository: repository.value.trim() }) as TeamStatus
    repository.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = ''
  }
}

async function update() {
  busy.value = 'update'
  error.value = ''
  try {
    status.value = await window.kernel.call('team.update') as TeamStatus
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    await refresh()
  } finally {
    busy.value = ''
  }
}

async function open() {
  const result = await window.kernel.call('team.open') as { team: { root: string } }
  await window.kernel.revealInFinder(result.team.root)
}

function changeMeta(change: TeamChange): string {
  const kind = {
    app: 'App',
    skill: 'Skill',
    routine: 'Routine',
    file: 'File',
    instructions: 'Guidance',
  }[change.kind]
  return `${kind} ${change.action}`
}

function versionLabel(change: TeamChange): string {
  if (!change.nextVersion) return ''
  if (!change.currentVersion) return `v${change.nextVersion}`
  return `v${change.currentVersion} → v${change.nextVersion}`
}

onMounted(() => {
  void load()
  window.kernel.on('team:changed', refresh)
  window.kernel.on('team:update-available', refresh)
})
onBeforeUnmount(() => {
  window.kernel.off('team:changed', refresh)
  window.kernel.off('team:update-available', refresh)
})
</script>

<template>
  <section class="flex flex-col gap-6 text-ink" aria-label="Team settings">
    <SettingsGroup v-if="connected && status?.team" :title="status.team.name">
      <div class="overflow-hidden rounded-[7px] border border-rule-light bg-surface">
        <div class="p-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-[14px] font-semibold text-ink">{{ stateTitle }}</div>
              <p class="mt-1 max-w-[520px] text-[11px] leading-5 text-ink-3">{{ stateDescription }}</p>
            </div>
            <button
              v-if="updateAvailable"
              type="button"
              data-testid="team-update"
              class="h-8 shrink-0 rounded-[5px] bg-accent px-4 text-[11px] font-semibold text-accent-ink hover:bg-accent/90 disabled:opacity-50"
              :disabled="busy !== ''"
              @click="update"
            >
              {{ busy === 'update' ? 'Updating' : 'Update' }}
            </button>
          </div>

          <div v-if="displayChanges.length" class="mt-4 divide-y divide-rule-light border-y border-rule-light">
            <div v-for="change in displayChanges" :key="`${change.kind}:${change.id}`" class="flex min-h-12 items-center justify-between gap-4 py-2.5">
              <div class="min-w-0">
                <div class="truncate text-[12px] font-medium text-ink">{{ change.name }}</div>
                <div class="mt-0.5 text-[10px] text-ink-3">
                  {{ changeMeta(change) }}
                  <span v-if="versionLabel(change)"> · {{ versionLabel(change) }}</span>
                </div>
              </div>
              <div v-if="change.accessChanged" class="shrink-0 text-right">
                <div class="text-[10px] font-semibold text-warn">Review access</div>
                <div class="mt-0.5 text-[9px] text-ink-3">This app asks for new access</div>
              </div>
            </div>
          </div>
        </div>

        <details class="border-t border-rule-light bg-chrome-light px-4 py-3 text-[11px] text-ink-3">
          <summary class="select-none rounded-[4px] py-1 hover:bg-chrome-mid">Developer details</summary>
          <div class="mt-3 flex items-end justify-between gap-4">
            <div class="min-w-0">
              <div class="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Repository</div>
              <div class="mt-1 truncate font-mono text-[10px] text-ink-2" :title="status.repository || ''">{{ status.repository }}</div>
            </div>
            <button type="button" data-testid="team-open" class="h-7 shrink-0 rounded-[5px] border border-rule-light bg-surface px-3 text-[11px] text-ink-2 hover:bg-chrome-mid" @click="open">
              Open Team folder
            </button>
          </div>
        </details>
      </div>
    </SettingsGroup>

    <SettingsGroup v-else-if="configured && status" title="Team">
      <div class="rounded-[7px] border border-rule-light bg-surface p-4">
        <div class="text-[14px] font-semibold text-ink">Needs attention</div>
        <p class="mt-1 text-[11px] leading-5 text-ink-3">{{ error || status.message }}</p>
        <button
          type="button"
          data-testid="team-retry"
          class="mt-4 h-8 rounded-[5px] bg-accent px-4 text-[11px] font-semibold text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          :disabled="busy !== ''"
          @click="load"
        >
          {{ busy === 'check' ? 'Trying again' : 'Try again' }}
        </button>
        <details class="mt-4 border-t border-rule-light pt-3 text-[11px] text-ink-3">
          <summary class="select-none rounded-[4px] py-1 hover:bg-chrome-mid">Developer details</summary>
          <div class="mt-2 truncate font-mono text-[10px] text-ink-2" :title="status.repository || ''">{{ status.repository }}</div>
        </details>
      </div>
    </SettingsGroup>

    <SettingsGroup v-else title="Connect your Team">
      <p class="pb-4 text-[11px] leading-5 text-ink-3">Add your company’s apps, skills, routines, files, and guidance to Mim. A Team is optional.</p>
      <SettingRow v-if="setupAction" label="Setup required" :desc="setupAction" />
      <SettingRow label="Team link" desc="Paste the link shared by your company.">
        <div class="flex min-w-[320px] gap-2">
          <input
            v-model="repository"
            placeholder="https://github.com/organisation/team.git"
            class="h-8 min-w-0 flex-1 rounded-[5px] border border-rule-light bg-surface px-2 text-[11px] text-ink outline-none hover:bg-chrome-mid focus-visible:border-accent"
            @keydown.enter="connect"
          />
          <button
            type="button"
            class="h-8 shrink-0 rounded-[5px] bg-accent px-3 text-[11px] font-semibold text-accent-ink hover:bg-accent/90 disabled:opacity-50"
            :disabled="busy !== '' || !repository.trim()"
            @click="connect"
          >
            {{ busy === 'connect' ? 'Connecting' : 'Connect Team' }}
          </button>
        </div>
      </SettingRow>
    </SettingsGroup>
    <p v-if="error && (connected || !configured)" class="m-0 text-[11px] text-rem">{{ error }}</p>
  </section>
</template>
