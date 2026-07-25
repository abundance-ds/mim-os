// One writable, Git-backed Team source per Mim installation.
// System Git is intentional: SSH keys and credential helpers are the sole
// authentication path, and the Team checkout must support ordinary Git writes.

import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { parse as parseYaml } from 'yaml'
import {
  gitInstallAction,
  gitLfsInstallAction,
  hasSystemGit,
  hasSystemGitLfs,
} from '@main/git.js'
import { userHomeDir } from '@main/platform.js'
import {
  clearSyncStop,
  isRetryableGitError,
  preserveRebaseConflicts,
  readSyncStop,
  writeSyncStop,
} from '@main/sync/conflicts.js'
import { loadUserConfig, setTeamConnection } from '@main/userConfig.js'
import {
  compareTeamReleases,
  parseTeamRelease,
  type TeamReleaseChange,
  type TeamReleaseIndex,
} from './teamRelease.js'
import { assertTeamReleaseContents } from './teamReleaseContents.js'

const execFileAsync = promisify(execFile)
const CONTRIBUTION_DIRS = ['files', 'skills', 'apps', 'routines'] as const

export interface TeamCheckout {
  name: string
  root: string
  manifestPath: string
  indexPath: string
  instructionsPath: string | null
  filesPath: string
  skillsPath: string
  appsPath: string
  routinesPath: string
  contributions: {
    instructions: boolean
    files: number
    skills: number
    apps: number
    routines: number
  }
}

export type TeamSourceState =
  | 'disconnected'
  | 'not-cloned'
  | 'invalid'
  | 'synced'
  | 'needs-sync'
  | 'stopped'

export interface TeamSourceStatus {
  state: TeamSourceState
  repository: string | null
  root: string
  team: TeamCheckout | null
  git: {
    available: boolean
    installAction: string | null
    lfsRequired: boolean
    lfsAvailable: boolean | null
    lfsInstallAction: string | null
  }
  dirty: boolean
  ahead: number
  behind: number
  conflicts: string[]
  retryable: boolean
  message: string
  update: {
    state: 'unknown' | 'current' | 'available'
    changes: TeamReleaseChange[]
    checkedAt: string | null
    availableRevision?: string
    appliedAt?: string
    recentChanges?: TeamReleaseChange[]
    error?: string
  }
}

export interface TeamSource {
  status(): Promise<TeamSourceStatus>
  connect(repository: string): Promise<TeamSourceStatus>
  open(): Promise<TeamCheckout>
  check(): Promise<TeamSourceStatus>
  publish(): Promise<TeamSourceStatus>
  update(): Promise<TeamSourceStatus>
}

export interface CreateTeamSourceOptions {
  homeDir?: string
  platform?: NodeJS.Platform
  hasGitLfs?: () => Promise<boolean>
}

export function teamCheckoutPath(home = userHomeDir()): string {
  return join(home, '.mim', 'team')
}

export function resolveTeamCheckout(root: string): TeamCheckout {
  return resolveTeamCheckoutLayout(root, true)
}

function resolveTeamCheckoutLayout(root: string, releaseRequired: boolean): TeamCheckout {
  const manifestPath = join(root, 'team.yaml')
  requireRegularFile(manifestPath, 'team.yaml is required')

  let raw: unknown
  try {
    raw = parseYaml(readFileSync(manifestPath, 'utf-8'))
  } catch {
    throw new Error('team.yaml must contain valid YAML')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('team.yaml must contain a mapping')
  }
  const nameValue = (raw as Record<string, unknown>).name
  if (typeof nameValue !== 'string' || !nameValue.trim()) {
    throw new Error('team.yaml must define a non-empty name')
  }
  const name = nameValue.trim()
  const indexPath = join(root, 'team-index.json')
  if (existsSync(indexPath)) {
    requireRegularFile(indexPath, 'team-index.json must be a regular file')
    const release = parseTeamRelease(readFileSync(indexPath, 'utf-8'))
    if (release.team !== name) {
      throw new Error('team-index.json team must match team.yaml name')
    }
  } else if (releaseRequired) {
    throw new Error('team-index.json is required')
  }

  const instructionsPath = join(root, 'instructions.md')
  if (existsSync(instructionsPath)) {
    requireRegularFile(instructionsPath, 'instructions.md must be a regular file')
  }

  const counts = {
    instructions: existsSync(instructionsPath),
    files: 0,
    skills: 0,
    apps: 0,
    routines: 0,
  }
  for (const contribution of CONTRIBUTION_DIRS) {
    const path = join(root, contribution)
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${contribution}/ must be a directory`)
    }
    counts[contribution] = readdirSync(path).filter(entry => !entry.startsWith('.')).length
  }

  return {
    name,
    root,
    manifestPath,
    indexPath,
    instructionsPath: counts.instructions ? instructionsPath : null,
    filesPath: join(root, 'files'),
    skillsPath: join(root, 'skills'),
    appsPath: join(root, 'apps'),
    routinesPath: join(root, 'routines'),
    contributions: counts,
  }
}

export function repositoryUsesGitLfs(root: string): boolean {
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (entry.isFile() && entry.name === '.gitattributes') {
        const attributes = readFileSync(path, 'utf-8')
        if (/\bfilter\s*=\s*lfs\b/i.test(attributes)) return true
      }
    }
  }
  return false
}

export function createTeamSource(options: CreateTeamSourceOptions = {}): TeamSource {
  const home = options.homeDir ?? userHomeDir()
  const platform = options.platform ?? process.platform
  const root = teamCheckoutPath(home)
  const hasGitLfs = options.hasGitLfs ?? hasSystemGitLfs
  const stopPath = join(root, '.git', 'mim-sync-stop.json')
  const receiptPath = join(root, '.git', 'mim-team-update.json')
  let lastCheckedAt: string | null = null

  async function gitAvailable(): Promise<boolean> {
    return hasSystemGit()
  }

  function repository(): string | null {
    return loadUserConfig(home).team?.repository ?? null
  }

  async function status(): Promise<TeamSourceStatus> {
    const available = await gitAvailable()
    const configured = repository()
    const git: TeamSourceStatus['git'] = {
      available,
      installAction: available ? null : gitInstallAction(platform),
      lfsRequired: false,
      lfsAvailable: null,
      lfsInstallAction: null,
    }
    if (!configured) {
      return baseStatus('disconnected', null, root, git, 'Connect a Team.')
    }
    if (!existsSync(root)) {
      return baseStatus('not-cloned', configured, root, git, 'Restoring the local Team copy.')
    }
    if (!available) {
      return baseStatus('stopped', configured, root, git, 'Git is required to check this Team.')
    }

    let team: TeamCheckout
    let indexedRelease = true
    try {
      if (existsSync(join(root, 'team-index.json'))) {
        team = resolveTeamCheckout(root)
      } else {
        team = resolveTeamCheckoutLayout(root, false)
        indexedRelease = false
      }
      const origin = await gitMaybe(root, ['remote', 'get-url', 'origin'])
      if (origin !== configured) {
        return {
          ...baseStatus('invalid', configured, root, git, 'The Team checkout origin does not match the connected repository.'),
          team,
        }
      }
    } catch (error) {
      return baseStatus(
        'invalid',
        configured,
        root,
        git,
        error instanceof Error ? error.message : String(error),
      )
    }

    let lfsRequired: boolean
    try {
      lfsRequired = repositoryUsesGitLfs(root)
    } catch (error) {
      return baseStatus(
        'invalid',
        configured,
        root,
        git,
        error instanceof Error ? error.message : String(error),
      )
    }
    const lfsAvailable = lfsRequired ? await hasGitLfs() : null
    git.lfsRequired = lfsRequired
    git.lfsAvailable = lfsAvailable
    git.lfsInstallAction = lfsRequired && !lfsAvailable ? gitLfsInstallAction(platform) : null
    if (lfsRequired && !lfsAvailable) {
      return {
        ...baseStatus('stopped', configured, root, git, `Git LFS is required. ${git.lfsInstallAction}`),
        team,
      }
    }

    const stop = readSyncStop(stopPath)
    if (stop) {
      return {
        ...baseStatus('stopped', configured, root, git, stop.message),
        team,
        conflicts: stop.conflicts,
        retryable: stop.retryable,
      }
    }

    const branchStatus = await gitMaybe(root, ['status', '--short', '--branch'])
    const lines = branchStatus.split('\n')
    const tracking = lines[0] ?? ''
    const dirty = lines.slice(1).some(line => line.trim().length > 0)
    const ahead = parseTrackingCount(tracking, 'ahead')
    const behind = parseTrackingCount(tracking, 'behind')
    const conflicts = (await gitMaybe(root, ['diff', '--name-only', '--diff-filter=U']))
      .split('\n')
      .filter(Boolean)
    const state: TeamSourceState = conflicts.length > 0
      ? 'stopped'
      : dirty || ahead > 0
        ? 'needs-sync'
        : 'synced'
    const update = await resolveUpdateStatus(
      root,
      team.name,
      lastCheckedAt,
      receiptPath,
      indexedRelease,
    )

    return {
      state,
      repository: configured,
      root,
      team,
      git,
      dirty,
      ahead,
      behind,
      conflicts,
      retryable: false,
      message: state === 'synced'
        ? update.state === 'available'
          ? 'A Team update is available.'
          : indexedRelease ? 'Up to date.' : 'Checking for the first Team update.'
        : state === 'stopped'
          ? 'Team changes need attention.'
          : 'Your Team changes are waiting to be published.',
      update,
    }
  }

  async function connect(repositoryValue: string): Promise<TeamSourceStatus> {
    const configured = repository()
    if (configured) throw new Error('A Team is already connected')
    const repositoryUrl = validateRepository(repositoryValue)
    if (!await gitAvailable()) {
      throw new Error(`Git is required to connect a Team. ${gitInstallAction(platform)}`)
    }
    if (existsSync(root)) {
      throw new Error(`A Team checkout already exists at ${root}`)
    }

    await cloneAndValidate(repositoryUrl)
    try {
      setTeamConnection({ repository: repositoryUrl }, home)
    } catch (error) {
      rmSync(root, { recursive: true, force: true })
      throw error
    }
    return status()
  }

  async function open(): Promise<TeamCheckout> {
    const current = await status()
    if (!current.repository) throw new Error('No Team is connected')
    if (!current.team || current.state === 'invalid' || current.state === 'not-cloned') {
      throw new Error(current.message)
    }
    if (current.git.lfsRequired && !current.git.lfsAvailable) throw new Error(current.message)
    return current.team
  }

  async function check(): Promise<TeamSourceStatus> {
    const configured = repository()
    if (!configured) throw new Error('No Team is connected')
    if (!await gitAvailable()) {
      throw new Error(`Git is required to check Team updates. ${gitInstallAction(platform)}`)
    }
    if (!existsSync(root)) {
      await cloneAndValidate(configured)
      return status()
    }
    try {
      await gitExec(root, ['fetch', '--prune', 'origin'])
      lastCheckedAt = new Date().toISOString()
      return status()
    } catch (error) {
      const current = await status()
      return {
        ...current,
        message: 'Could not check for Team updates. Your current Team still works.',
        update: {
          ...current.update,
          error: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  async function publish(): Promise<TeamSourceStatus> {
    const configured = repository()
    if (!configured) throw new Error('No Team is connected')
    if (!await gitAvailable()) {
      throw new Error(`Git is required to publish Team changes. ${gitInstallAction(platform)}`)
    }
    if (!existsSync(root)) {
      await cloneAndValidate(configured)
      return status()
    }

    clearSyncStop(stopPath)
    const before = await status()
    if (before.state === 'invalid') throw new Error(before.message)
    if (before.git.lfsRequired && !before.git.lfsAvailable) throw new Error(before.message)
    if (before.conflicts.length > 0) return before
    if (!existsSync(join(root, 'team-index.json'))) {
      return {
        ...before,
        message: 'Install the available Team update before publishing Team changes.',
      }
    }

    try {
      await gitExec(root, ['add', '-A'])
      const pending = await gitMaybe(root, ['status', '--short'])
      if (pending.trim()) await gitExec(root, ['commit', '-m', 'Update Team content'])
      await gitExec(root, ['fetch', '--prune', 'origin'])
      lastCheckedAt = new Date().toISOString()
      const divergence = await branchDivergence(root)
      if (divergence.behind === 0 && divergence.ahead > 0) await gitExec(root, ['push'])
    } catch (error) {
      const retryable = isRetryableGitError(error)
      if (retryable) {
        const current = await status()
        return {
          ...current,
          message: 'Your Team changes are saved here and will publish when the connection returns.',
          retryable: true,
        }
      }
      const current = await status()
      return {
        ...current,
        state: 'stopped',
        retryable: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return status()
  }

  async function update(): Promise<TeamSourceStatus> {
    const configured = repository()
    if (!configured) throw new Error('No Team is connected')
    if (!await gitAvailable()) {
      throw new Error(`Git is required to update the Team. ${gitInstallAction(platform)}`)
    }
    if (!existsSync(root)) {
      await cloneAndValidate(configured)
      return status()
    }

    clearSyncStop(stopPath)
    const before = await status()
    if (before.state === 'invalid') throw new Error(before.message)
    if (before.git.lfsRequired && !before.git.lfsAvailable) throw new Error(before.message)
    if (before.conflicts.length > 0) return before
    const beforeRelease = existsSync(join(root, 'team-index.json'))
      ? readLocalRelease(root)
      : emptyTeamRelease(before.team?.name ?? 'Team')

    try {
      await gitExec(root, ['add', '-A'])
      const pending = await gitMaybe(root, ['status', '--short'])
      if (pending.trim()) await gitExec(root, ['commit', '-m', 'Update Team content'])
      await gitExec(root, ['fetch', '--prune', 'origin'])
      lastCheckedAt = new Date().toISOString()
      await requireValidRemoteRelease(root, before.team?.name ?? beforeRelease.team)
      await gitExec(root, ['pull', '--rebase'])
      const updatedTeam = resolveTeamCheckout(root)
      assertTeamReleaseContents(root, readLocalRelease(root))
      if (updatedTeam.name !== beforeRelease.team) {
        throw new Error('The installed Team identity changed unexpectedly.')
      }
      await gitExec(root, ['push'])
      const afterRelease = readLocalRelease(root)
      const changes = compareTeamReleases(beforeRelease, afterRelease)
      const revision = await gitMaybe(root, ['rev-parse', 'HEAD'])
      if (changes.length > 0) {
        writeFileSync(receiptPath, JSON.stringify({
          revision,
          appliedAt: new Date().toISOString(),
          changes,
        }), 'utf-8')
      }
    } catch (error) {
      const preserved = await preserveRebaseConflicts(root, stopPath, 'Team')
      if (preserved) return status()
      if (isRetryableGitError(error)) {
        const current = await status()
        return {
          ...current,
          message: 'The Team update will be ready when the connection returns.',
          retryable: true,
          update: {
            ...current.update,
            error: error instanceof Error ? error.message : String(error),
          },
        }
      }
      const current = await status()
      return {
        ...current,
        state: 'stopped',
        retryable: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return status()
  }

  async function cloneAndValidate(repositoryUrl: string): Promise<void> {
    const personalDir = join(home, '.mim')
    mkdirSync(personalDir, { recursive: true })
    const tempParent = mkdtempSync(join(personalDir, 'team-clone-'))
    const clonePath = join(tempParent, `repo-${randomBytes(4).toString('hex')}`)
    try {
      await gitExec(undefined, ['clone', '--', repositoryUrl, clonePath], {
        GIT_LFS_SKIP_SMUDGE: '1',
      })
      const clonedTeam = resolveTeamCheckout(clonePath)
      assertTeamReleaseContents(clonePath, readLocalRelease(clonePath))
      if (clonedTeam.name !== readLocalRelease(clonePath).team) {
        throw new Error('The Team identity does not match its release.')
      }
      if (repositoryUsesGitLfs(clonePath)) {
        if (!await hasGitLfs()) {
          throw new Error(`Git LFS is required. ${gitLfsInstallAction(platform)}`)
        }
        await gitExec(clonePath, ['lfs', 'pull'])
      }
      renameSync(clonePath, root)
    } finally {
      rmSync(tempParent, { recursive: true, force: true })
    }
  }

  return { status, connect, open, check, publish, update }
}

async function resolveUpdateStatus(
  root: string,
  teamName: string,
  checkedAt: string | null,
  receiptPath: string,
  indexedRelease: boolean,
): Promise<TeamSourceStatus['update']> {
  const local = indexedRelease ? readLocalRelease(root) : emptyTeamRelease(teamName)
  try {
    const remote = await readRemoteRelease(root)
    if (!remote) return { state: 'unknown', changes: [], checkedAt }
    if (remote.index.team !== teamName) {
      throw new Error('The available Team update belongs to a different Team.')
    }
    const changes = compareTeamReleases(local, remote.index)
    if (changes.length > 0) {
      return {
        state: 'available',
        changes,
        checkedAt,
        availableRevision: remote.revision,
      }
    }
    const receipt = readReceipt(receiptPath)
    return {
      state: 'current',
      changes: [],
      checkedAt,
      ...(receipt
        ? { appliedAt: receipt.appliedAt, recentChanges: receipt.changes }
        : {}),
    }
  } catch (error) {
    return {
      state: 'unknown',
      changes: [],
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function emptyTeamRelease(team: string): TeamReleaseIndex {
  return {
    manifestVersion: 1,
    team,
    apps: [],
    skills: [],
    routines: [],
    files: [],
    instructions: null,
  }
}

function readLocalRelease(root: string): TeamReleaseIndex {
  return parseTeamRelease(readFileSync(join(root, 'team-index.json'), 'utf-8'))
}

async function readRemoteRelease(root: string): Promise<{
  index: TeamReleaseIndex
  revision: string
} | null> {
  const upstream = await gitMaybe(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (!upstream) return null
  const source = await gitMaybe(root, ['show', `${upstream}:team-index.json`])
  if (!source) return null
  return {
    index: parseTeamRelease(source),
    revision: await gitMaybe(root, ['rev-parse', upstream]),
  }
}

async function requireValidRemoteRelease(root: string, teamName: string): Promise<void> {
  const remote = await readRemoteRelease(root)
  if (!remote) throw new Error('The Team repository has no published update index.')
  if (remote.index.team !== teamName) {
    throw new Error('The available Team update belongs to a different Team.')
  }
  const parent = mkdtempSync(join(root, '..', 'team-release-'))
  const checkout = join(parent, 'checkout')
  try {
    await gitExec(root, ['worktree', 'add', '--detach', checkout, remote.revision])
    const team = resolveTeamCheckout(checkout)
    if (team.name !== teamName) {
      throw new Error('The available Team update belongs to a different Team.')
    }
    assertTeamReleaseContents(checkout, remote.index)
  } finally {
    await gitExec(root, ['worktree', 'remove', '--force', checkout]).catch(() => {})
    rmSync(parent, { recursive: true, force: true })
  }
}

async function branchDivergence(root: string): Promise<{ ahead: number; behind: number }> {
  const value = await gitMaybe(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
  const [ahead = 0, behind = 0] = value.split(/\s+/).map(Number)
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  }
}

function readReceipt(path: string): {
  appliedAt: string
  changes: TeamReleaseChange[]
} | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as {
      appliedAt?: unknown
      changes?: unknown
    }
    if (typeof value.appliedAt !== 'string' || !Array.isArray(value.changes)) return null
    return { appliedAt: value.appliedAt, changes: value.changes as TeamReleaseChange[] }
  } catch {
    return null
  }
}

function requireRegularFile(path: string, message: string): void {
  if (!existsSync(path)) throw new Error(message)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message)
}

function validateRepository(value: string): string {
  const repository = value.trim()
  if (!repository || /[\r\n\0]/.test(repository)) throw new Error('repository must be a non-empty Git location')
  if (repository.startsWith('-')) throw new Error('repository must not begin with "-"')

  if (/^https?:\/\//i.test(repository)) {
    const parsed = new URL(repository)
    if (parsed.protocol !== 'https:') throw new Error('Team HTTP repositories must use HTTPS')
    if (parsed.username || parsed.password) {
      throw new Error('Team repository URLs must not contain credentials; use the system Git credential helper')
    }
  }
  return repository
}

async function gitExec(
  cwd: string | undefined,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', cwd ? ['-C', cwd, ...args] : args, {
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : undefined,
    })
    return stdout.trimEnd()
  } catch (error) {
    const stderr = typeof error === 'object' && error && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim()
      : ''
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
  }
}

async function gitMaybe(cwd: string, args: string[]): Promise<string> {
  try {
    return await gitExec(cwd, args)
  } catch {
    return ''
  }
}

function parseTrackingCount(line: string, label: 'ahead' | 'behind'): number {
  const match = line.match(new RegExp(`\\b${label} (\\d+)\\b`))
  return match ? Number(match[1]) : 0
}

function baseStatus(
  state: TeamSourceState,
  repository: string | null,
  root: string,
  git: TeamSourceStatus['git'],
  message: string,
): TeamSourceStatus {
  return {
    state,
    repository,
    root,
    team: null,
    git,
    dirty: false,
    ahead: 0,
    behind: 0,
    conflicts: [],
    retryable: false,
    message,
    update: {
      state: 'unknown',
      changes: [],
      checkedAt: null,
    },
  }
}
