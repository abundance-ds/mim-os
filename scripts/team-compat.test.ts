import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { createTraceLog } from '@main/trace/trace.js'
import { type HttpClient, type HttpResponse } from '@main/integrations/http.js'
import { createMemorySecretStore, MIM_KEYCHAIN_SERVICE } from '@main/integrations/secrets.js'
import { createToolRegistry, type ToolRegistry } from '@main/tools/registry.js'
import { createPackageLoader, type PackageLoader } from '@main/packages/packages.js'
import { createPackageEnablementStore, type PackageEnablementStore } from '@main/packages/packageEnablement.js'
import { createPackageRuntime, type PackageRuntime } from '@main/packages/packageRuntime.js'
import { createPackageJobRunner } from '@main/packages/packageJobs.js'
import { createNamedPackageToolSync, type NamedPackageToolSync } from '@main/packages/namedPackageTools.js'
import { packageSecretAccount } from '@main/packages/packageSecrets.js'
import { registerCoreAppTools } from '@main/tools/coreApps.js'
import { registerPackageRuntimeTools } from '@main/tools/packageRuntime.js'
import { registerFileTools } from '@main/tools/fs.js'
import { registerDocumentTools } from '@main/tools/documents.js'
import { registerReferencesTools } from '@main/tools/references.js'
import { parseTeamRelease } from '@main/team/teamRelease.js'
import { assertTeamReleaseContents } from '@main/team/teamReleaseContents.js'

const runCompat = process.env.MIM_TEAM_COMPAT === '1'
const describeCompat = runCompat ? describe : describe.skip

interface PackageJson {
  name?: string
  version?: string
  mim?: {
    id?: string
    backend?: string
    permissions?: {
      secrets?: string[]
    }
    provides?: {
      tools?: Array<string | { name?: string }>
    }
  }
}

interface Harness {
  root: string
  workspacePath: string
  teamRoot: string
  selectedIds: string[]
  packageJsonById: Map<string, PackageJson>
  tools: ToolRegistry
  packages: PackageLoader
  enablement: PackageEnablementStore
  runtime: PackageRuntime
  namedTools: NamedPackageToolSync
}

let harness: Harness | null = null

describeCompat('Team app compatibility', () => {
  beforeAll(async () => {
    const teamRoot = resolveTeamRoot()
    if (!existsSync(teamRoot)) {
      throw new Error(`Team repository not found: ${teamRoot}. Set MIM_TEAM_PATH=/path/to/team.`)
    }
    assertTeamReleaseContents(
      teamRoot,
      parseTeamRelease(readFileSync(join(teamRoot, 'team-index.json'), 'utf-8')),
    )

    const sourcePackageDirs = discoverPackageDirs(teamRoot)
    const selectedIds = selectedPackageIds(sourcePackageDirs.map(pkg => pkg.id))
    assertSelectedPackagesExist(sourcePackageDirs.map(pkg => pkg.id), selectedIds)

    const root = mkdtempSync(join(tmpdir(), 'mim-team-compat-'))
    const workspace = join(root, 'workspace')
    const mimDir = join(root, 'mim-built-ins')
    const teamDir = join(root, 'team-apps')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(mimDir, { recursive: true })
    mkdirSync(teamDir, { recursive: true })
    writeFileSync(join(workspace, 'mim.yaml'), 'name: team-compat\n')

    const packageJsonById = new Map<string, PackageJson>()
    for (const id of selectedIds) {
      const srcDir = join(teamRoot, 'apps', id)
      const packageJson = readPackageJson(srcDir)
      requireString(packageJson.version, `${id} package version`)
      const destDir = join(teamDir, id)
      copyPackageDir(srcDir, destDir)
      packageJsonById.set(id, packageJson)
    }

    const trace = createTraceLog({ devConsole: false })
    const tools = createToolRegistry(trace)
    tools.setWorkspacePath(workspace)
    registerFileTools(tools)
    registerDocumentTools(tools)
    registerReferencesTools(tools)

    const packages = await createPackageLoader(tools, { mimDir, teamDir })
    const enablement = createPackageEnablementStore({ getWorkspacePath: () => workspace })
    const secrets = createMemorySecretStore()
    for (const [id, packageJson] of packageJsonById) {
      for (const secret of packageJson.mim?.permissions?.secrets ?? []) {
        await secrets.set(MIM_KEYCHAIN_SERVICE, packageSecretAccount(id, secret), `compat-${secret}`)
      }
    }
    const runtime = createPackageRuntime({
      packages,
      enablement,
      tools,
      trace,
      secrets,
      http: compatHttpClient,
    })
    const jobs = createPackageJobRunner({
      runtime,
      trace,
      getWorkspacePath: () => workspace,
      emit: () => undefined,
    })
    const namedTools = createNamedPackageToolSync({ runtime, tools, packages })

    registerCoreAppTools(tools, {
      packages,
      enablement,
      invalidate: (id) => runtime.invalidate(id),
    })
    registerPackageRuntimeTools(tools, packages, runtime, jobs)

    for (const id of selectedIds) {
      await tools.call('app.trust', { id }, { actor: 'user' })
      await tools.call('app.enable', { id, layer: 'local' }, { actor: 'user' })
    }
    await namedTools.sync()

    harness = {
      root,
      workspacePath: workspace,
      teamRoot,
      selectedIds,
      packageJsonById,
      tools,
      packages,
      enablement,
      runtime,
      namedTools,
    }
  }, 60_000)

  afterAll(async () => {
    if (!harness) return
    await harness.packages.close?.()
    rmSync(harness.root, { recursive: true, force: true })
    harness = null
  })

  it('uses every app published in the Team index by default', () => {
    const h = requireHarness()
    if (process.env.MIM_COMPAT_PACKAGES) return

    const index = JSON.parse(readFileSync(join(h.teamRoot, 'team-index.json'), 'utf-8')) as {
      apps: Array<{ id: string }>
    }
    const expected = index.apps
      .map(app => app.id)
      .sort()

    expect(h.selectedIds).toEqual(expected)
  })

  it('loads selected app manifests without loader diagnostics', () => {
    const h = requireHarness()
    expect(h.packages.diagnostics(), `loader diagnostics:\n${JSON.stringify(h.packages.diagnostics(), null, 2)}`).toEqual([])
    const loadedIds = h.packages.list().map(pkg => pkg.manifest.id).sort()
    expect(loadedIds).toEqual([...h.selectedIds].sort())
  })

  it('enables every selected app through app.enable', async () => {
    const h = requireHarness()
    const result = await h.tools.call('app.status', {}, { actor: 'user' }) as {
      apps: Array<{ id: string; enabled: boolean; folderPresent: boolean }>
    }
    const statusById = new Map(result.apps.map(app => [app.id, app]))

    for (const id of h.selectedIds) {
      const status = statusById.get(id)
      expect(status, `${id} should be listed by app.status`).toBeDefined()
      expect(status?.enabled, `${id} should be enabled`).toBe(true)

      const pkg = h.packages.get(id)
      if (pkg?.manifest.dataFolder) {
        expect(status?.folderPresent, `${id} data folder should be created`).toBe(true)
      }
    }
  })

  it('imports selected app backends and exposes valid capabilities', async () => {
    const h = requireHarness()
    const result = await h.tools.call('package.capabilities.list', {}, { actor: 'user' }) as {
      packages: Array<{
        packageId: string
        jobs: unknown[]
        tools: unknown[]
        diagnostics: string[]
      }>
    }
    const capabilitiesById = new Map(result.packages.map(pkg => [pkg.packageId, pkg]))

    for (const id of h.selectedIds) {
      const capabilities = capabilitiesById.get(id)
      expect(capabilities, `${id} should appear in app capabilities list`).toBeDefined()
      expect(capabilities?.diagnostics, `${id} backend diagnostics`).toEqual([])

      const declaredBackend = h.packageJsonById.get(id)?.mim?.backend
      if (declaredBackend) {
        const capabilityCount = (capabilities?.jobs.length ?? 0) + (capabilities?.tools.length ?? 0)
        expect(capabilityCount, `${id} should expose at least one job or tool`).toBeGreaterThan(0)
      }
    }
  })

  it('registers manifest-granted named app tools', () => {
    const h = requireHarness()
    expect(h.namedTools.diagnostics()).toEqual([])

    for (const id of h.selectedIds) {
      const pkg = h.packages.get(id)
      const grants = pkg?.manifest.provides?.tools ?? []
      for (const grant of grants) {
        if (grant.pattern.endsWith('.*')) continue
        expect(h.tools.get(grant.pattern), `${id} should register ${grant.pattern}`).toBeDefined()
        expect(h.namedTools.getPolicy(grant.pattern), `${grant.pattern} should have a dynamic gate policy`).toBeDefined()
      }
    }
  })

  it('runs app-owned compatibility smoke hooks', async () => {
    const h = requireHarness()
    const hooks: string[] = []

    for (const id of h.selectedIds) {
      const pkg = h.packages.get(id)
      if (!pkg) continue

      const hookPath = join(pkg.dir, 'compat.mjs')
      if (!existsSync(hookPath)) continue

      const mod = await import(`${pathToFileURL(hookPath).href}?mimCompat=${Date.now()}`)
      const smoke = typeof mod.smoke === 'function'
        ? mod.smoke
        : typeof mod.default === 'function'
          ? mod.default
          : null
      if (!smoke) throw new Error(`${id} compat.mjs must export smoke() or a default function`)

      await smoke({
        tools: h.tools,
        packageId: id,
        workspacePath: h.workspacePath,
        packageDir: pkg.dir,
      })
      hooks.push(id)
    }

    const expectedHooks = h.selectedIds.filter(id => {
      const pkg = h.packages.get(id)
      return pkg ? existsSync(join(pkg.dir, 'compat.mjs')) : false
    }).sort()
    expect(hooks.sort()).toEqual(expectedHooks)
  }, 60_000)
})

const compatHttpClient: HttpClient = {
  async request() {
    return jsonResponse({ data: [] })
  },
}

function jsonResponse(value: unknown, status = 200): HttpResponse {
  const text = JSON.stringify(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value
    },
    async text() {
      return text
    },
  }
}

function requireHarness(): Harness {
  if (!harness) throw new Error('compat harness was not initialized')
  return harness
}

function resolveTeamRoot(): string {
  const raw = process.env.MIM_TEAM_PATH
  if (!raw) throw new Error('Set MIM_TEAM_PATH=/path/to/team')
  return resolve(raw)
}

function discoverPackageDirs(teamRoot: string): Array<{ id: string; dir: string }> {
  const packagesDir = join(teamRoot, 'apps')
  if (!existsSync(packagesDir)) throw new Error(`apps directory not found: ${packagesDir}`)
  const indexPath = join(teamRoot, 'team-index.json')
  if (!existsSync(indexPath)) throw new Error(`Team index not found: ${indexPath}`)
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
    apps?: Array<{ id?: unknown }>
  }
  if (!Array.isArray(index.apps)) throw new Error(`Team index has no apps array: ${indexPath}`)

  return index.apps
    .filter((app): app is { id: string } => typeof app.id === 'string')
    .map(app => {
      const dir = join(packagesDir, app.id)
      if (!existsSync(join(dir, 'package.json'))) {
        throw new Error(`indexed Team app is missing: ${app.id}`)
      }
      return { id: app.id, dir }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

function selectedPackageIds(allIds: string[]): string[] {
  const raw = process.env.MIM_COMPAT_PACKAGES
  if (!raw) return [...allIds].sort()
  if (raw.trim() === 'all') return [...allIds].sort()
  return raw.split(',').map(id => id.trim()).filter(Boolean).sort()
}

function assertSelectedPackagesExist(allIds: string[], selectedIds: string[]): void {
  const all = new Set(allIds)
  const missing = selectedIds.filter(id => !all.has(id))
  if (missing.length > 0) {
    throw new Error(`MIM_COMPAT_PACKAGES selected missing Team app ids: ${missing.join(', ')}`)
  }
}

function readPackageJson(packageDir: string): PackageJson {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as PackageJson
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${label}`)
  return value
}

function copyPackageDir(srcDir: string, destDir: string): void {
  mkdirSync(dirname(destDir), { recursive: true })
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(srcDir, src).split(sep).join('/')
      return !rel.split('/').includes('node_modules') && !rel.startsWith('.git/')
    },
  })
}
