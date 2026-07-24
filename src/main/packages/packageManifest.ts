import { existsSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

export type PackageSource = 'mim' | 'team' | 'project'
export type PackageViewRole = 'work' | 'artifact' | 'either'

// Packages may not claim system/settings/secrets categories — those are core-only.
export type PackageToolCategory = 'read' | 'write' | 'general' | 'network' | 'ai' | 'search' | 'ui'
export type PackageToolRisk = 'low' | 'medium' | 'high'

export interface PackageToolGrant {
  pattern: string
  category: PackageToolCategory
  risk: PackageToolRisk
}

export interface PackageView {
  id: string
  label: string
  src: string
  role: PackageViewRole
}

export interface PackageTui {
  entry: string
}

export interface PackagePermissions {
  workspace?: {
    read?: boolean
    write?: boolean
  }
  ai?: boolean
  http?: string[]
  secrets?: string[]
}

export interface MimPackageManifest {
  manifestVersion: 1
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  views: PackageView[]
  tui?: PackageTui
  backend?: string
  permissions: PackagePermissions
  provides?: { tools: PackageToolGrant[] }
  dataFolder?: string
  engines?: {
    mim?: string
  }
}

export interface PackageDiagnostic {
  path: string
  message: string
  packageId?: string
}

const MIM_KEYS = new Set([
  'manifestVersion',
  'id',
  'name',
  'description',
  'icon',
  'views',
  'tui',
  'backend',
  'permissions',
  'provides',
  'dataFolder',
  'engines',
])

export function parsePackageManifest(
  packageJson: Record<string, unknown>,
  packageDir: string,
): { manifest: MimPackageManifest | null; diagnostics: PackageDiagnostic[] } {
  const diagnostics: PackageDiagnostic[] = []
  const errors: PackageDiagnostic[] = []
  const raw = packageJson.mim

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      manifest: null,
      diagnostics: [{ path: packageDir, message: 'Missing package.json mim block' }],
    }
  }

  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!MIM_KEYS.has(key) && !key.startsWith('x-')) {
      // Unknown keys are warnings — they do not prevent loading.
      diagnostics.push({ path: packageDir, message: `Unknown mim key: ${key}` })
    }
  }

  if (input.manifestVersion !== 1) {
    errors.push({ path: packageDir, message: 'mim.manifestVersion must be 1' })
  }

  const id = readString(input.id)
  if (!id || !isValidPackageId(id)) {
    errors.push({ path: packageDir, message: 'mim.id must be lowercase letters, numbers, hyphens, or underscores' })
  }

  const name = readString(input.name)
  if (!name) {
    errors.push({ path: packageDir, message: 'mim.name is required' })
  }

  const views = parseViews(input.views, packageDir, errors)
  const tui = parseTui(input.tui, packageDir, errors)
  const backend = parsePackagePath(input.backend, packageDir, 'backend', errors, { mustExist: true })
  const permissions = parsePermissions(input.permissions, packageDir, errors)

  // provides/dataFolder diagnostics are soft: drop individual entries, never the manifest.
  const soft: PackageDiagnostic[] = []
  const provides = parseProvides(input.provides, packageDir, soft)
  const dataFolder = parseDataFolder(input.dataFolder, packageDir, soft)

  // Errors are fatal: without a valid id/name/manifestVersion the package
  // cannot be loaded. Warnings (unknown keys, dropped provides/dataFolder
  // entries) are non-fatal and carried alongside the manifest.
  if (errors.length > 0) return { manifest: null, diagnostics: [...diagnostics, ...errors, ...soft] }

  return {
    manifest: {
      manifestVersion: 1,
      id: id!,
      name: name!,
      version: readString(packageJson.version) ?? '0.0.0',
      description: readString(input.description),
      icon: readString(input.icon),
      views,
      tui,
      backend,
      permissions,
      provides,
      dataFolder,
      engines: parseEngines(input.engines),
    },
    diagnostics: [...diagnostics, ...soft],
  }
}

export function isValidPackageId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,59}$/.test(id) && !id.includes('..')
}

export function isValidCapabilityId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(id) && !id.includes('..')
}

export function resolveInsidePackage(packageDir: string, requestedPath: string): string | null {
  if (!requestedPath || isAbsolute(requestedPath)) return null
  const resolved = resolve(packageDir, requestedPath)
  const rel = relative(packageDir, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return resolved
}

export function relativePackagePath(packageDir: string, fullPath: string): string {
  return relative(packageDir, fullPath).replace(/\\/g, '/')
}

function parseViews(value: unknown, packageDir: string, diagnostics: PackageDiagnostic[]): PackageView[] {
  if (value == null) return []
  if (!Array.isArray(value)) {
    diagnostics.push({ path: packageDir, message: 'mim.views must be an array' })
    return []
  }

  const views: PackageView[] = []
  const ids = new Set<string>()

  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push({ path: packageDir, message: `mim.views[${index}] must be an object` })
      continue
    }
    const raw = item as Record<string, unknown>
    const id = readString(raw.id)
    const label = readString(raw.label)
    const src = readString(raw.src)
    const role = readString(raw.role)

    if (!id || !isValidCapabilityId(id)) {
      diagnostics.push({ path: packageDir, message: `mim.views[${index}].id is invalid` })
      continue
    }
    if (ids.has(id)) {
      diagnostics.push({ path: packageDir, message: `Duplicate view id: ${id}` })
      continue
    }
    ids.add(id)

    if (!label) diagnostics.push({ path: packageDir, message: `mim.views[${index}].label is required` })
    if (!isPackageViewRole(role)) {
      diagnostics.push({ path: packageDir, message: `mim.views[${index}].role must be work, artifact, or either` })
      continue
    }
    const resolved = src ? resolveInsidePackage(packageDir, src) : null
    if (!src || !resolved) {
      diagnostics.push({ path: packageDir, message: `mim.views[${index}].src must stay inside the package directory` })
      continue
    }
    const rel = relativePackagePath(packageDir, resolved)
    if (!rel.startsWith('ui/')) {
      diagnostics.push({ path: packageDir, message: `mim.views[${index}].src must point inside ui/` })
      continue
    }
    if (!existsSync(resolved)) {
      diagnostics.push({ path: packageDir, message: `View file does not exist: ${src}` })
      continue
    }

    views.push({ id, label: label!, src, role })
  }
  return views
}

function isPackageViewRole(value: string | undefined): value is PackageViewRole {
  return value === 'work' || value === 'artifact' || value === 'either'
}

function parseTui(
  value: unknown,
  packageDir: string,
  diagnostics: PackageDiagnostic[],
): PackageTui | undefined {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ path: packageDir, message: 'mim.tui must be an object' })
    return undefined
  }

  const entry = readString((value as Record<string, unknown>).entry)
  const resolved = entry ? resolveInsidePackage(packageDir, entry) : null
  if (!entry || !resolved) {
    diagnostics.push({ path: packageDir, message: 'mim.tui.entry must stay inside the package directory' })
    return undefined
  }
  const rel = relativePackagePath(packageDir, resolved)
  if (!rel.startsWith('tui/')) {
    diagnostics.push({ path: packageDir, message: 'mim.tui.entry must point inside tui/' })
    return undefined
  }
  if (!existsSync(resolved)) {
    diagnostics.push({ path: packageDir, message: `TUI entry file does not exist: ${entry}` })
    return undefined
  }
  return { entry }
}

function parsePackagePath(
  value: unknown,
  packageDir: string,
  key: string,
  diagnostics: PackageDiagnostic[],
  options: { mustExist: boolean },
): string | undefined {
  if (value == null) return undefined
  const path = readString(value)
  const resolved = path ? resolveInsidePackage(packageDir, path) : null
  if (!path || !resolved) {
    diagnostics.push({ path: packageDir, message: `mim.${key} must stay inside the package directory` })
    return undefined
  }
  if (options.mustExist && !existsSync(resolved)) {
    diagnostics.push({ path: packageDir, message: `Backend file does not exist: ${path}` })
    return undefined
  }
  return path
}

function parsePermissions(value: unknown, packageDir: string, diagnostics: PackageDiagnostic[]): PackagePermissions {
  if (value == null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ path: packageDir, message: 'mim.permissions must be an object' })
    return {}
  }

  const raw = value as Record<string, unknown>
  const permissions: PackagePermissions = {}

  if (raw.workspace != null) {
    if (!raw.workspace || typeof raw.workspace !== 'object' || Array.isArray(raw.workspace)) {
      diagnostics.push({ path: packageDir, message: 'mim.permissions.workspace must be an object' })
    } else {
      const workspace = raw.workspace as Record<string, unknown>
      permissions.workspace = {
        read: workspace.read === true,
        write: workspace.write === true,
      }
    }
  }
  if (raw.ai != null) {
    if (typeof raw.ai !== 'boolean') diagnostics.push({ path: packageDir, message: 'mim.permissions.ai must be boolean' })
    else permissions.ai = raw.ai
  }
  if (raw.http != null) {
    if (!Array.isArray(raw.http)) {
      diagnostics.push({ path: packageDir, message: 'mim.permissions.http must be an array' })
    } else {
      permissions.http = raw.http.filter((host): host is string => {
        if (typeof host !== 'string' || !isValidHostPattern(host)) {
          diagnostics.push({ path: packageDir, message: `Invalid HTTP permission host: ${String(host)}` })
          return false
        }
        return true
      })
    }
  }
  if (raw.secrets != null) {
    if (!Array.isArray(raw.secrets)) {
      diagnostics.push({ path: packageDir, message: 'mim.permissions.secrets must be an array' })
    } else {
      permissions.secrets = raw.secrets.filter((secret): secret is string => {
        if (typeof secret !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(secret)) {
          diagnostics.push({ path: packageDir, message: `Invalid secret permission: ${String(secret)}` })
          return false
        }
        return true
      })
    }
  }

  return permissions
}

function isValidHostPattern(host: string): boolean {
  if (host === '*') return true
  if (host.includes('/') || host.includes(':') || host.trim() !== host) return false
  const normalized = host.startsWith('*.') ? host.slice(2) : host
  if (!normalized.includes('.')) return false
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(normalized)
}

function parseEngines(value: unknown): MimPackageManifest['engines'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const mim = readString((value as Record<string, unknown>).mim)
  return mim ? { mim } : undefined
}

// ---------------------------------------------------------------------------
// provides.tools — named-tool grants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set<PackageToolCategory>(['read', 'write', 'general', 'network', 'ai', 'search', 'ui'])
// Packages may not claim these — core-only categories.
const FORBIDDEN_CATEGORIES = new Set(['system', 'settings', 'secrets'])

const VALID_RISKS = new Set<PackageToolRisk>(['low', 'medium', 'high'])

// Destructive final segments — risk floor 'high' is enforced at parse time for
// non-wildcard patterns and at runtime for wildcard resolution.
const DESTRUCTIVE_SEGMENTS = new Set(['delete', 'remove', 'purge', 'destroy', 'uninstall', 'reset'])

const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/

function isValidToolPattern(pattern: string): boolean {
  if (pattern.length > 80) return false
  const segments = pattern.split('.')
  if (segments.length < 2) return false
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (i === segments.length - 1 && seg === '*') continue
    if (!SEGMENT_RE.test(seg)) return false
  }
  return true
}

function parseProvides(
  value: unknown,
  packageDir: string,
  diagnostics: PackageDiagnostic[],
): MimPackageManifest['provides'] {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ path: packageDir, message: 'mim.provides must be an object' })
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (raw.tools == null) return undefined
  if (!Array.isArray(raw.tools)) {
    diagnostics.push({ path: packageDir, message: 'mim.provides.tools must be an array' })
    return undefined
  }

  const tools: PackageToolGrant[] = []
  for (const [index, entry] of (raw.tools as unknown[]).entries()) {
    const grant = parseToolGrantEntry(entry, index, packageDir, diagnostics)
    if (grant) tools.push(grant)
  }

  return tools.length > 0 ? { tools } : undefined
}

function parseToolGrantEntry(
  entry: unknown,
  index: number,
  packageDir: string,
  diagnostics: PackageDiagnostic[],
): PackageToolGrant | null {
  let pattern: string | undefined
  let rawCategory: string | undefined
  let rawRisk: string | undefined

  if (typeof entry === 'string') {
    pattern = entry
  } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>
    pattern = readString(obj.name)
    rawCategory = readString(obj.category)
    rawRisk = readString(obj.risk)
  } else {
    diagnostics.push({ path: packageDir, message: `mim.provides.tools[${index}] must be a string or object` })
    return null
  }

  if (!pattern || !isValidToolPattern(pattern)) {
    diagnostics.push({ path: packageDir, message: `mim.provides.tools[${index}]: invalid pattern "${pattern ?? ''}"` })
    return null
  }

  // Category: coerce forbidden to 'general'
  let category: PackageToolCategory = 'general'
  if (rawCategory) {
    if (FORBIDDEN_CATEGORIES.has(rawCategory)) {
      diagnostics.push({ path: packageDir, message: `mim.provides.tools[${index}]: category "${rawCategory}" is reserved, using "general"` })
    } else if (VALID_CATEGORIES.has(rawCategory as PackageToolCategory)) {
      category = rawCategory as PackageToolCategory
    } else {
      diagnostics.push({ path: packageDir, message: `mim.provides.tools[${index}]: unknown category "${rawCategory}", using "general"` })
    }
  }

  // Risk: default 'medium', unknown → diagnostic + default
  let risk: PackageToolRisk = 'medium'
  if (rawRisk) {
    if (VALID_RISKS.has(rawRisk as PackageToolRisk)) {
      risk = rawRisk as PackageToolRisk
    } else {
      diagnostics.push({ path: packageDir, message: `mim.provides.tools[${index}]: unknown risk "${rawRisk}", using "medium"` })
    }
  }

  // Risk floor for non-wildcard patterns with destructive final segment
  const isWildcard = pattern.endsWith('.*')
  if (!isWildcard) {
    const before = risk
    risk = applyToolRiskFloor(pattern, risk)
    if (risk !== before) {
      diagnostics.push({ path: packageDir, message: `mim.provides.tools[${index}]: risk floor "high" applied for destructive tool "${pattern}"` })
    }
  }

  return { pattern, category, risk }
}

// ---------------------------------------------------------------------------
// dataFolder
// ---------------------------------------------------------------------------

const DATA_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const RESERVED_DATA_FOLDERS = new Set(['packages', 'skills', 'node_modules', 'sessions'])

function parseDataFolder(
  value: unknown,
  packageDir: string,
  diagnostics: PackageDiagnostic[],
): string | undefined {
  if (value == null) return undefined
  const folder = readString(value)
  if (!folder || !DATA_FOLDER_RE.test(folder)) {
    diagnostics.push({ path: packageDir, message: `mim.dataFolder: invalid folder name "${String(value)}"` })
    return undefined
  }
  if (RESERVED_DATA_FOLDERS.has(folder)) {
    diagnostics.push({ path: packageDir, message: `mim.dataFolder: "${folder}" is reserved` })
    return undefined
  }
  return folder
}

// ---------------------------------------------------------------------------
// Exported helpers for runtime tool resolution
// ---------------------------------------------------------------------------

/** Exact match, or wildcard 'issues.*' matches any name with prefix 'issues.' (multi-segment ok). */
export function matchesToolGrant(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.endsWith('.*')) return false
  const prefix = pattern.slice(0, -1) // 'issues.*' → 'issues.'
  return name.startsWith(prefix) && name.length > prefix.length
}

/** Returns 'high' when name's final segment is destructive and declared risk is lower; else declared. */
export function applyToolRiskFloor(name: string, declared: PackageToolRisk): PackageToolRisk {
  const finalSegment = name.split('.').pop()
  if (finalSegment && DESTRUCTIVE_SEGMENTS.has(finalSegment) && declared !== 'high') {
    return 'high'
  }
  return declared
}

/** Validates a concrete public tool name (dotted, >=2 segments, no wildcard). */
export function isValidPublicToolName(name: string): boolean {
  if (name.length > 80) return false
  const segments = name.split('.')
  if (segments.length < 2) return false
  return segments.every(seg => SEGMENT_RE.test(seg))
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
