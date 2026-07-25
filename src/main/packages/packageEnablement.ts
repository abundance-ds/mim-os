import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { LoadedPackage } from './packages.js'
import { atomicWriteJson } from '@main/atomicJson.js'

interface EnablementFile {
  enabled?: string[]
  disabled?: string[]
  trusted?: TrustEntry[]
}

interface TrustEntry {
  id: string
  grants: string[]
}

export type EnablementPackage = Pick<LoadedPackage, 'manifest' | 'source' | 'dir'>

export interface PackageEnablementStore {
  isEnabled(pkg: EnablementPackage): boolean
  setEnabled(packageId: string, enabled: boolean): void
  clearOverride(packageId: string): void
  localOverride(packageId: string): boolean | null
  isTrusted(pkg: EnablementPackage): boolean
  ackTrust(pkg: EnablementPackage): void
  needsTrust(pkg: EnablementPackage): boolean
  diagnostics(): string[]
}

export function createPackageEnablementStore(options: {
  getWorkspacePath: () => string | null
}): PackageEnablementStore {
  type State = Required<EnablementFile>
  let cachedPath: string | null = null
  let cachedState: State = { enabled: [], disabled: [], trusted: [] }
  let cachedDiagnostics: string[] = []

  function statePath(): string | null {
    const project = options.getWorkspacePath()
    return project ? join(project, '.mim', 'packages', 'enabled.json') : null
  }

  function load(): State {
    const path = statePath()
    if (!path) {
      cachedPath = null
      cachedState = { enabled: [], disabled: [], trusted: [] }
      cachedDiagnostics = []
      return cachedState
    }
    if (cachedPath === path) return cachedState
    cachedPath = path
    cachedDiagnostics = []
    if (!existsSync(path)) {
      cachedState = { enabled: [], disabled: [], trusted: [] }
      return cachedState
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as EnablementFile
      cachedState = {
        enabled: Array.isArray(raw.enabled) ? raw.enabled.filter(isPackageId) : [],
        disabled: Array.isArray(raw.disabled) ? raw.disabled.filter(isPackageId) : [],
        trusted: Array.isArray(raw.trusted) ? raw.trusted.filter(isTrustEntry).map(entry => ({
          id: entry.id,
          grants: [...new Set(entry.grants)].sort(),
        })) : [],
      }
    } catch (error) {
      cachedDiagnostics = [`Could not read app enablement file: ${(error as Error).message}`]
      cachedState = { enabled: [], disabled: [], trusted: [] }
    }
    return cachedState
  }

  function save(state: State): void {
    const path = statePath()
    if (!path) throw new Error('No Project open')
    const clean = {
      enabled: [...new Set(state.enabled)].sort(),
      disabled: [...new Set(state.disabled)].sort(),
      trusted: state.trusted
        .map(entry => ({ id: entry.id, grants: [...new Set(entry.grants)].sort() }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }
    atomicWriteJson(path, clean)
    cachedPath = path
    cachedState = clean
  }

  function requiresTrust(pkg: EnablementPackage): boolean {
    return pkg.source !== 'mim' && (
      pkg.manifest.backend !== undefined
      || pkg.manifest.tui !== undefined
      || pkg.manifest.permissions.workspace?.read === true
      || pkg.manifest.permissions.workspace?.write === true
      || pkg.manifest.permissions.ai === true
      || (pkg.manifest.permissions.http?.length ?? 0) > 0
      || (pkg.manifest.permissions.secrets?.length ?? 0) > 0
    )
  }

  function isTrusted(pkg: EnablementPackage): boolean {
    if (!requiresTrust(pkg)) return true
    const reviewed = load().trusted.find(entry => entry.id === pkg.manifest.id)
    if (!reviewed) return false
    const grants = new Set(reviewed.grants)
    return requiredGrants(pkg).every(grant => grants.has(grant))
  }

  return {
    isEnabled(pkg) {
      const state = load()
      if (state.disabled.includes(pkg.manifest.id)) return false
      return state.enabled.includes(pkg.manifest.id)
        && (!requiresTrust(pkg) || isTrusted(pkg))
    },
    setEnabled(packageId, enabled) {
      if (!isPackageId(packageId)) throw new Error(`Invalid app id: ${packageId}`)
      const state = load()
      save({
        enabled: enabled
          ? [...state.enabled.filter(id => id !== packageId), packageId]
          : state.enabled.filter(id => id !== packageId),
        disabled: enabled
          ? state.disabled.filter(id => id !== packageId)
          : [...state.disabled.filter(id => id !== packageId), packageId],
        trusted: state.trusted,
      })
    },
    clearOverride(packageId) {
      if (!isPackageId(packageId)) throw new Error(`Invalid app id: ${packageId}`)
      const state = load()
      save({
        enabled: state.enabled.filter(id => id !== packageId),
        disabled: state.disabled.filter(id => id !== packageId),
        trusted: state.trusted,
      })
    },
    localOverride(packageId) {
      const state = load()
      if (state.enabled.includes(packageId)) return true
      if (state.disabled.includes(packageId)) return false
      return null
    },
    isTrusted,
    ackTrust(pkg) {
      const id = pkg.manifest.id
      const state = load()
      save({
        enabled: state.enabled,
        disabled: state.disabled,
        trusted: [
          ...state.trusted.filter(entry => entry.id !== id),
          { id, grants: requiredGrants(pkg) },
        ],
      })
    },
    needsTrust(pkg) {
      return requiresTrust(pkg) && !isTrusted(pkg)
    },
    diagnostics() {
      load()
      return cachedDiagnostics
    },
  }
}

function isPackageId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,59}$/.test(value)
}

function isTrustEntry(value: unknown): value is TrustEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return isPackageId(entry.id)
    && Array.isArray(entry.grants)
    && entry.grants.every(grant => typeof grant === 'string' && grant.length > 0)
}

function requiredGrants(pkg: EnablementPackage): string[] {
  const grants: string[] = []
  if (pkg.manifest.backend !== undefined) grants.push('code.backend')
  if (pkg.manifest.tui !== undefined) grants.push('code.tui')
  if (pkg.manifest.permissions.workspace?.read === true) grants.push('workspace.read')
  if (pkg.manifest.permissions.workspace?.write === true) grants.push('workspace.write')
  if (pkg.manifest.permissions.ai === true) grants.push('ai')
  for (const target of pkg.manifest.permissions.http ?? []) grants.push(`http:${target}`)
  for (const secret of pkg.manifest.permissions.secrets ?? []) grants.push(`secret:${secret}`)
  return [...new Set(grants)].sort()
}
