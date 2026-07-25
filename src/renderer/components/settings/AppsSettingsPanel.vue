<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { IconPlus, IconRefresh } from '@tabler/icons-vue'
import { useAppsStore, type ResolvedApp } from '../../stores/coreApps.js'
import type {
  PackageCapabilities,
  PackageDiagnostic,
  PackageSummary,
} from '../packages/packageManagerTypes.js'
import { permissionLines } from '../packages/permissionSummary.js'
import AgentsSettingsPanel from './AgentsSettingsPanel.vue'
import PermissionConfirmDialog from '../apps/PermissionConfirmDialog.vue'
import MimDialog from '../ui/MimDialog.vue'
import MimSelect from '../ui/MimSelect.vue'
import MimToggle from '../ui/MimToggle.vue'

const emit = defineEmits<{
  openPackage: [id: string]
  openPackageDocs: [id: string]
}>()

interface AppTemplateSummary {
  id: string
  label: string
  summary: string
  defaultId: string
  defaultName: string
}

interface AppRow {
  id: string
  name: string
  description: string
  source: 'project' | 'team' | 'mim'
  version?: string
  enabled: boolean
  needsTrust: boolean
  shadowed: boolean
  hasViews: boolean
  hasReadme: boolean
  pkg: PackageSummary
  app?: ResolvedApp
}

const appsStore = useAppsStore()
const loading = ref(false)
const error = ref('')
const busy = ref('')
const filter = ref('')
const expanded = ref('')
const developerOpen = ref('')
const packages = ref<PackageSummary[]>([])
const diagnostics = ref<PackageDiagnostic[]>([])
const capabilities = ref<PackageCapabilities[]>([])
const templates = ref<AppTemplateSummary[]>([])
const teamName = ref('Team')
const projectName = ref('Project')
const pendingTrust = ref<AppRow | null>(null)

const createOpen = ref(false)
const createDestination = ref<'project' | 'team'>('project')
const templateId = ref('')
const newId = ref('')
const newName = ref('')

const buttonClass = 'inline-flex h-[22px] items-center justify-center rounded-[5px] border border-rule bg-chrome-high px-2 text-[10.5px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink disabled:opacity-50'
const sourceChipClass = 'inline-flex h-[17px] items-center rounded-full bg-chrome-mid px-1.5 text-[9px] font-semibold text-ink-3'

function naturalSource(source: string): AppRow['source'] {
  if (source === 'team') return 'team'
  if (source === 'mim') return 'mim'
  return 'project'
}

function originLabel(source: AppRow['source']): string {
  if (source === 'team') return teamName.value
  if (source === 'mim') return 'Mim'
  return projectName.value
}

const rows = computed<AppRow[]>(() => packages.value
  .map(pkg => {
    const app = appsStore.apps[pkg.id]
    return {
      id: pkg.id,
      name: pkg.name,
      description: pkg.description ?? '',
      source: naturalSource(pkg.source),
      version: pkg.version,
      enabled: app?.enabled ?? pkg.enabled,
      needsTrust: app?.needsTrust ?? false,
      shadowed: app?.shadowed ?? false,
      hasViews: (pkg.views?.length ?? 0) > 0,
      hasReadme: pkg.hasReadme === true,
      pkg,
      app,
    }
  })
  .filter(row => {
    const query = filter.value.trim().toLowerCase()
    return !query
      || row.name.toLowerCase().includes(query)
      || row.description.toLowerCase().includes(query)
      || originLabel(row.source).toLowerCase().includes(query)
  })
  .sort((a, b) => a.name.localeCompare(b.name)))

const sections = computed(() => [
  { id: 'active', label: 'Active in this Project', rows: rows.value.filter(row => row.enabled) },
  { id: 'available', label: 'Available', rows: rows.value.filter(row => !row.enabled) },
])

const templateOptions = computed(() => templates.value.map(template => ({
  value: template.id,
  label: template.label,
  title: template.summary,
})))

const destinationOptions = computed(() => [
  { value: 'project', label: projectName.value },
  { value: 'team', label: teamName.value },
])

function diagnosticLines(id: string): string[] {
  return diagnostics.value
    .filter(item => item.packageId === id || item.path.includes(`/${id}/`))
    .map(item => item.message)
}

function capabilityGroups(id: string) {
  const cap = capabilities.value.find(item => item.packageId === id)
  if (!cap) return []
  return [
    { label: 'Jobs', items: cap.jobs.map(item => item.label || item.id) },
    { label: 'Tools', items: cap.tools.map(item => item.label || item.name) },
    { label: 'Agents', items: cap.agents?.map(item => item.name) ?? [] },
    { label: 'Skills', items: cap.skills?.map(item => item.label || item.id) ?? [] },
  ].filter(group => group.items.length)
}

async function toggle(row: AppRow): Promise<void> {
  if (!row.enabled && row.needsTrust) {
    pendingTrust.value = row
    return
  }
  busy.value = `toggle:${row.id}`
  error.value = ''
  try {
    await appsStore.setEnabled(row.id, !row.enabled)
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    busy.value = ''
    await refresh()
  }
}

async function trustAndEnable(): Promise<void> {
  const row = pendingTrust.value
  if (!row) return
  busy.value = `toggle:${row.id}`
  try {
    await appsStore.trust(row.id)
    await appsStore.setEnabled(row.id, true)
    pendingTrust.value = null
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    busy.value = ''
    await refresh()
  }
}

function chooseTemplate(value: string | number): void {
  templateId.value = String(value)
  const template = templates.value.find(item => item.id === templateId.value)
  if (!template) return
  newId.value = template.defaultId
  newName.value = template.defaultName
}

function openCreate(): void {
  if (!templateId.value && templates.value[0]) chooseTemplate(templates.value[0].id)
  createOpen.value = true
}

async function createApp(): Promise<void> {
  busy.value = 'create'
  error.value = ''
  try {
    const params = await window.kernel.call('app.templateContent', {
      templateId: templateId.value,
      id: newId.value.trim(),
      name: newName.value.trim(),
    }) as Record<string, unknown>
    await window.kernel.call('package.create', {
      ...params,
      destination: createDestination.value,
      override: true,
    })
    await window.kernel.call('package.reload', { id: newId.value.trim() })
    createOpen.value = false
    expanded.value = newId.value.trim()
    await refresh()
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    busy.value = ''
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [packageResult, capabilityResult, templateResult, teamResult, workspace] = await Promise.all([
      window.kernel.call('package.list'),
      window.kernel.call('package.capabilities.list'),
      window.kernel.call('app.templateList', {}),
      window.kernel.call('team.status').catch(() => null),
      window.kernel.getWorkspace().catch(() => ''),
      appsStore.refresh(),
    ])
    const packageData = packageResult as { packages?: PackageSummary[]; diagnostics?: PackageDiagnostic[] }
    packages.value = packageData.packages ?? []
    diagnostics.value = packageData.diagnostics ?? []
    capabilities.value = (capabilityResult as { packages?: PackageCapabilities[] }).packages ?? []
    templates.value = (templateResult as { templates?: AppTemplateSummary[] }).templates ?? []
    const team = teamResult as { team?: { name?: string } } | null
    teamName.value = team?.team?.name || 'Team'
    if (typeof workspace === 'string' && workspace) {
      projectName.value = workspace.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? 'Project'
    }
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    loading.value = false
  }
}

async function reload(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    await window.kernel.call('package.reload', {})
    await refresh()
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    loading.value = false
  }
}

function onChanged(): void {
  void refresh()
}

onMounted(() => {
  void refresh()
  window.kernel.on('apps:changed', onChanged)
  window.kernel.on('packages:changed', onChanged)
  window.kernel.on('team:changed', onChanged)
  window.kernel.on('workspace:changed', onChanged)
})

onBeforeUnmount(() => {
  window.kernel.off('apps:changed', onChanged)
  window.kernel.off('packages:changed', onChanged)
  window.kernel.off('team:changed', onChanged)
  window.kernel.off('workspace:changed', onChanged)
})
</script>

<template>
  <div aria-label="Apps settings" class="flex h-full min-h-0 flex-col px-5 pt-4 font-sans">
    <div class="flex items-center gap-2 pb-3">
      <label class="flex h-6 items-center rounded-[6px] border border-rule-light bg-chrome-mid px-2 focus-within:border-accent">
        <input
          v-model="filter"
          class="w-[150px] border-0 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-4"
          placeholder="Filter apps and origins"
        />
      </label>
      <span class="font-mono text-[9px] text-ink-4">{{ rows.filter(row => row.enabled).length }} active</span>
      <button
        type="button"
        data-testid="app-new-template-open"
        :class="[buttonClass, 'ml-auto gap-1']"
        :disabled="!templates.length"
        @click="openCreate"
      >
        <IconPlus :size="12" />
        New app
      </button>
      <button
        type="button"
        class="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-ink-3 hover:bg-chrome-mid hover:text-ink disabled:opacity-50"
        :disabled="loading"
        aria-label="Refresh apps"
        @click="reload"
      >
        <IconRefresh :size="13" />
      </button>
    </div>

    <div v-if="error" class="mb-2 rounded-[6px] border border-rem/30 px-2.5 py-2 text-[11px] text-rem">
      {{ error }}
    </div>

    <div class="flex-1 overflow-y-auto pr-1">
      <section v-for="section in sections" :key="section.id" class="mb-4">
        <div class="mb-1.5 flex items-center justify-between">
          <h2 class="text-[9px] font-semibold uppercase tracking-[1.8px] text-ink-3">{{ section.label }}</h2>
          <span class="font-mono text-[9px] text-ink-4">{{ section.rows.length }}</span>
        </div>
        <div class="overflow-hidden rounded-[8px] border border-rule-light bg-surface">
          <article
            v-for="row in section.rows"
            :key="row.id"
            class="border-b border-rule-light last:border-b-0"
            :class="expanded === row.id ? 'bg-chrome-high' : ''"
          >
            <div class="flex items-stretch" :class="expanded === row.id ? '' : 'hover:bg-chrome-mid'">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
                :data-testid="`apps-row-${row.id}`"
                :aria-expanded="expanded === row.id"
                @click="expanded = expanded === row.id ? '' : row.id"
              >
                <span class="text-[11px] text-ink-4">{{ expanded === row.id ? '⌄' : '›' }}</span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 text-[11.5px] font-medium text-ink">
                    {{ row.name }}
                    <span :class="sourceChipClass" :data-testid="`app-origin-${row.id}`">{{ originLabel(row.source) }}</span>
                    <span v-if="row.shadowed" class="rounded-full bg-accent-soft px-1.5 text-[9px] font-semibold text-accent">Override</span>
                  </span>
                  <span class="mt-0.5 block truncate text-[10px] leading-4 text-ink-3">
                    {{ row.description || `${originLabel(row.source)} app` }}
                  </span>
                </span>
              </button>
              <div class="flex items-center px-3">
                <MimToggle
                  :data-testid="`apps-toggle-${row.id}`"
                  :model-value="row.enabled"
                  :disabled="busy === `toggle:${row.id}`"
                  :aria-label="`${row.name} ${row.enabled ? 'enabled' : 'disabled'}`"
                  @update:model-value="toggle(row)"
                />
              </div>
            </div>

            <div v-if="expanded === row.id" class="space-y-2 border-t border-rule-light px-3 py-2.5 text-[10.5px] text-ink-3">
              <div class="flex flex-wrap gap-x-4 gap-y-1">
                <span>Origin: {{ originLabel(row.source) }}</span>
                <span v-if="row.version">Version {{ row.version }}</span>
                <span>{{ row.source === 'team' ? `Managed by ${teamName}` : row.source === 'mim' ? 'Managed by Mim' : 'Managed by this Project' }}</span>
              </div>
              <div>
                <span class="font-medium text-ink-2">Access</span>
                <span class="ml-1">{{ permissionLines(row.pkg.permissions ?? {}).join(' · ') }}</span>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button v-if="row.hasViews" type="button" :class="buttonClass" :data-testid="`app-open-${row.id}`" @click="emit('openPackage', row.id)">Open</button>
                <button v-if="row.hasReadme" type="button" :class="buttonClass" :data-testid="`app-docs-${row.id}`" @click="emit('openPackageDocs', row.id)">Documentation</button>
                <button type="button" :class="buttonClass" :data-testid="`app-developer-toggle-${row.id}`" @click="developerOpen = developerOpen === row.id ? '' : row.id">Developer details</button>
              </div>
              <div v-if="developerOpen === row.id" class="rounded-[6px] bg-chrome-mid p-2" :data-testid="`app-developer-${row.id}`">
                <div v-for="group in capabilityGroups(row.id)" :key="group.label" class="mb-1 last:mb-0">
                  <span class="font-semibold text-ink-2">{{ group.label }}:</span>
                  {{ group.items.join(', ') }}
                </div>
                <div v-for="line in diagnosticLines(row.id)" :key="line" class="text-rem">{{ line }}</div>
                <div v-if="!capabilityGroups(row.id).length && !diagnosticLines(row.id).length">No runtime diagnostics.</div>
              </div>
            </div>
          </article>
          <div v-if="!section.rows.length" class="px-3 py-4 text-center text-[10.5px] text-ink-4">
            {{ filter ? 'No matches' : section.id === 'active' ? 'No active apps' : 'No available apps' }}
          </div>
        </div>
      </section>

      <AgentsSettingsPanel />
    </div>

    <PermissionConfirmDialog
      :open="pendingTrust !== null"
      :app-name="pendingTrust?.name ?? ''"
      :permissions="pendingTrust?.pkg.permissions ?? {}"
      :test-id="pendingTrust ? `apps-enable-permissions-${pendingTrust.id}` : undefined"
      :confirm-test-id="pendingTrust ? `apps-enable-confirm-${pendingTrust.id}` : undefined"
      @update:open="value => { if (!value) pendingTrust = null }"
      @confirm="trustAndEnable"
    />

    <MimDialog :open="createOpen" title="Create app" size="md" @close="createOpen = false">
      <form class="flex flex-col gap-3 p-4" @submit.prevent="createApp">
        <label class="flex flex-col gap-1 text-[11px] text-ink-2">
          Destination
          <MimSelect :model-value="createDestination" :options="destinationOptions" @update:model-value="createDestination = String($event) as 'project' | 'team'" />
        </label>
        <label class="flex flex-col gap-1 text-[11px] text-ink-2">
          Template
          <MimSelect :model-value="templateId" :options="templateOptions" @update:model-value="chooseTemplate" />
        </label>
        <label class="flex flex-col gap-1 text-[11px] text-ink-2">
          App id
          <input v-model="newId" class="h-7 rounded-[5px] border border-rule-light bg-surface px-2 text-[11px] text-ink outline-none focus:border-accent" />
        </label>
        <label class="flex flex-col gap-1 text-[11px] text-ink-2">
          Name
          <input v-model="newName" class="h-7 rounded-[5px] border border-rule-light bg-surface px-2 text-[11px] text-ink outline-none focus:border-accent" />
        </label>
        <div class="flex justify-end gap-2">
          <button type="button" :class="buttonClass" @click="createOpen = false">Cancel</button>
          <button type="submit" :class="buttonClass" :disabled="!templateId || !newId.trim() || !newName.trim() || busy === 'create'">Create</button>
        </div>
      </form>
    </MimDialog>
  </div>
</template>
