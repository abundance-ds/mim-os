export interface TeamReleaseApp {
  id: string
  name: string
  description?: string
  version: string
  digest: string
  permissions: Record<string, unknown>
  execution: {
    backend: boolean
    tui: boolean
  }
  engines?: Record<string, unknown>
}

export interface TeamReleaseSkill {
  id: string
  name: string
  description: string
  version: string
  digest: string
}

export interface TeamReleasePath {
  path: string
  digest: string
}

export interface TeamReleaseIndex {
  manifestVersion: 1
  team: string
  apps: TeamReleaseApp[]
  skills: TeamReleaseSkill[]
  routines: TeamReleasePath[]
  files: TeamReleasePath[]
  instructions: { digest: string } | null
}

export type TeamReleaseChangeKind = 'app' | 'skill' | 'routine' | 'file' | 'instructions'
export type TeamReleaseChangeAction = 'added' | 'updated' | 'removed'

export interface TeamReleaseChange {
  kind: TeamReleaseChangeKind
  id: string
  name: string
  action: TeamReleaseChangeAction
  currentVersion?: string
  nextVersion?: string
  accessChanged?: boolean
}

const VERSION = /^\d+\.\d+\.\d+$/
const DIGEST = /^[a-f0-9]{64}$/

export function parseTeamRelease(source: string): TeamReleaseIndex {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('team-index.json must contain valid JSON')
  }
  const index = record(value, 'team-index.json')
  if (index.manifestVersion !== 1) {
    throw new Error('team-index.json manifestVersion must be 1')
  }
  const team = nonEmptyString(index.team, 'team-index.json team')
  const apps = array(index.apps, 'team-index.json apps').map((entry, position) => {
    const app = record(entry, `team-index.json apps[${position}]`)
    const execution = record(app.execution, `apps[${position}].execution`)
    if (typeof execution.backend !== 'boolean' || typeof execution.tui !== 'boolean') {
      throw new Error(`apps[${position}].execution must define backend and tui booleans`)
    }
    return {
      id: nonEmptyString(app.id, `apps[${position}].id`),
      name: nonEmptyString(app.name, `apps[${position}].name`),
      ...(typeof app.description === 'string' && app.description.trim()
        ? { description: app.description.trim() }
        : {}),
      version: version(app.version, `apps[${position}].version`),
      digest: digest(app.digest, `apps[${position}].digest`),
      permissions: isRecord(app.permissions) ? app.permissions : {},
      execution: {
        backend: execution.backend,
        tui: execution.tui,
      },
      ...(isRecord(app.engines) ? { engines: app.engines } : {}),
    }
  })
  const skills = array(index.skills, 'team-index.json skills').map((entry, position) => {
    const skill = record(entry, `team-index.json skills[${position}]`)
    return {
      id: nonEmptyString(skill.id, `skills[${position}].id`),
      name: nonEmptyString(skill.name, `skills[${position}].name`),
      description: nonEmptyString(skill.description, `skills[${position}].description`),
      version: version(skill.version, `skills[${position}].version`),
      digest: digest(skill.digest, `skills[${position}].digest`),
    }
  })
  const routines = pathEntries(index.routines, 'routines')
  const files = pathEntries(index.files, 'files')
  let instructions: TeamReleaseIndex['instructions'] = null
  if (index.instructions !== null) {
    const entry = record(index.instructions, 'team-index.json instructions')
    instructions = { digest: digest(entry.digest, 'instructions.digest') }
  }
  uniqueIds(apps, 'apps')
  uniqueIds(skills, 'skills')
  uniquePaths(routines, 'routines')
  uniquePaths(files, 'files')
  return { manifestVersion: 1, team, apps, skills, routines, files, instructions }
}

export function compareTeamReleases(
  current: TeamReleaseIndex,
  available: TeamReleaseIndex,
): TeamReleaseChange[] {
  const changes: TeamReleaseChange[] = [
    ...compareVersioned('app', current.apps, available.apps),
    ...compareVersioned('skill', current.skills, available.skills),
    ...comparePaths('routine', current.routines, available.routines),
    ...comparePaths('file', current.files, available.files),
  ]
  if (current.instructions?.digest !== available.instructions?.digest) {
    changes.push({
      kind: 'instructions',
      id: 'instructions',
      name: 'Team instructions',
      action: current.instructions
        ? available.instructions ? 'updated' : 'removed'
        : 'added',
    })
  }
  return changes
}

function compareVersioned(
  kind: 'app' | 'skill',
  currentEntries: Array<TeamReleaseApp | TeamReleaseSkill>,
  availableEntries: Array<TeamReleaseApp | TeamReleaseSkill>,
): TeamReleaseChange[] {
  const current = new Map(currentEntries.map(entry => [entry.id, entry]))
  const available = new Map(availableEntries.map(entry => [entry.id, entry]))
  const changes: TeamReleaseChange[] = []
  for (const id of [...new Set([...current.keys(), ...available.keys()])].sort()) {
    const before = current.get(id)
    const after = available.get(id)
    if (!after && before) {
      changes.push({
        kind,
        id,
        name: before.name,
        action: 'removed',
        currentVersion: before.version,
      })
      continue
    }
    if (after && !before) {
      const change: TeamReleaseChange = {
        kind,
        id,
        name: after.name,
        action: 'added',
        nextVersion: after.version,
      }
      if (kind === 'app' && appAccessTokens(after as TeamReleaseApp).size > 0) {
        change.accessChanged = true
      }
      changes.push(change)
      continue
    }
    if (!before || !after || (
      before.digest === after.digest
      && before.version === after.version
    )) continue
    const change: TeamReleaseChange = {
      kind,
      id,
      name: after.name,
      action: 'updated',
      currentVersion: before.version,
      nextVersion: after.version,
    }
    if (kind === 'app' && appAccessExpanded(
      before as TeamReleaseApp,
      after as TeamReleaseApp,
    )) {
      change.accessChanged = true
    }
    changes.push(change)
  }
  return changes
}

function comparePaths(
  kind: 'routine' | 'file',
  currentEntries: TeamReleasePath[],
  availableEntries: TeamReleasePath[],
): TeamReleaseChange[] {
  const current = new Map(currentEntries.map(entry => [entry.path, entry]))
  const available = new Map(availableEntries.map(entry => [entry.path, entry]))
  const changes: TeamReleaseChange[] = []
  for (const path of [...new Set([...current.keys(), ...available.keys()])].sort()) {
    const before = current.get(path)
    const after = available.get(path)
    if (before?.digest === after?.digest) continue
    changes.push({
      kind,
      id: path,
      name: path,
      action: before ? after ? 'updated' : 'removed' : 'added',
    })
  }
  return changes
}

function appAccessExpanded(before: TeamReleaseApp, after: TeamReleaseApp): boolean {
  const approved = appAccessTokens(before)
  return [...appAccessTokens(after)].some(token => !approved.has(token))
}

function appAccessTokens(app: TeamReleaseApp): Set<string> {
  const tokens = permissionTokens(app.permissions)
  if (app.execution.backend) tokens.add('code.backend')
  if (app.execution.tui) tokens.add('code.tui')
  return tokens
}

function permissionTokens(value: Record<string, unknown>): Set<string> {
  const tokens = new Set<string>()
  const visit = (entry: unknown, prefix: string) => {
    if (entry === true) {
      tokens.add(prefix)
      return
    }
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === 'string') tokens.add(`${prefix}:${item}`)
      }
      return
    }
    if (!isRecord(entry)) return
    for (const [key, child] of Object.entries(entry)) {
      visit(child, prefix ? `${prefix}.${key}` : key)
    }
  }
  visit(value, '')
  return tokens
}

function pathEntries(value: unknown, key: string): TeamReleasePath[] {
  return array(value, `team-index.json ${key}`).map((entry, position) => {
    const item = record(entry, `${key}[${position}]`)
    return {
      path: nonEmptyString(item.path, `${key}[${position}].path`),
      digest: digest(item.digest, `${key}[${position}].digest`),
    }
  })
}

function uniqueIds(entries: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`team-index.json ${label} contains duplicate id: ${entry.id}`)
    ids.add(entry.id)
  }
}

function uniquePaths(entries: TeamReleasePath[], label: string): void {
  const paths = new Set<string>()
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`team-index.json ${label} contains duplicate path: ${entry.path}`)
    paths.add(entry.path)
  }
}

function version(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label)
  if (!VERSION.test(parsed)) throw new Error(`${label} must use major.minor.patch`)
  return parsed
}

function digest(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label)
  if (!DIGEST.test(parsed)) throw new Error(`${label} must be a SHA-256 digest`)
  return parsed
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
