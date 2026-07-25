import { createHash } from 'crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'fs'
import { join, relative, sep } from 'path'
import { isDeepStrictEqual } from 'util'
import type {
  TeamReleaseApp,
  TeamReleaseIndex,
  TeamReleasePath,
  TeamReleaseSkill,
} from './teamRelease.js'

const IGNORED_NAMES = new Set(['.DS_Store', '.git', 'node_modules'])
const VERSION = /^\d+\.\d+\.\d+$/

export function buildTeamReleaseIndex(root: string, team: string): TeamReleaseIndex {
  return {
    manifestVersion: 1,
    team,
    apps: collectApps(root),
    skills: collectSkills(root),
    routines: collectPathEntries(join(root, 'routines')),
    files: collectPathEntries(join(root, 'files')),
    instructions: regularFile(join(root, 'instructions.md'))
      ? { digest: sha256(readFileSync(join(root, 'instructions.md'))) }
      : null,
  }
}

export function assertTeamReleaseContents(root: string, index: TeamReleaseIndex): void {
  const actual = buildTeamReleaseIndex(root, index.team)
  if (!isDeepStrictEqual(actual, index)) {
    throw new Error('team-index.json does not match the Team files; publish a fresh Team release')
  }
}

function collectApps(root: string): TeamReleaseApp[] {
  const appsRoot = join(root, 'apps')
  if (!realDirectory(appsRoot)) return []
  const apps: TeamReleaseApp[] = []
  for (const entry of sortedEntries(appsRoot)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const appRoot = join(appsRoot, entry.name)
    const manifestPath = join(appRoot, 'package.json')
    if (!regularFile(manifestPath)) {
      throw new Error(`apps/${entry.name}/package.json is required`)
    }
    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
    } catch {
      throw new Error(`apps/${entry.name}/package.json must contain valid JSON`)
    }
    const mim = record(pkg.mim, `apps/${entry.name}/package.json mim`)
    if (mim.id !== entry.name) {
      throw new Error(`apps/${entry.name}/package.json mim.id must match its folder`)
    }
    const version = requiredVersion(pkg.version, `apps/${entry.name}/package.json version`)
    const name = requiredString(mim.name, `apps/${entry.name}/package.json mim.name`)
    const permissions = isRecord(mim.permissions) ? sortObject(mim.permissions) : {}
    const app: TeamReleaseApp = {
      id: entry.name,
      name,
      ...(typeof mim.description === 'string' && mim.description.trim()
        ? { description: mim.description.trim() }
        : {}),
      version,
      digest: digestTree(appRoot, (path) => path === 'package.json'
        ? normalizedAppManifest(readFileSync(join(appRoot, path), 'utf-8'))
        : undefined),
      permissions,
      execution: {
        backend: typeof mim.backend === 'string',
        tui: isRecord(mim.tui),
      },
      ...(isRecord(mim.engines) ? { engines: sortObject(mim.engines) } : {}),
    }
    apps.push(app)
  }
  return apps
}

function collectSkills(root: string): TeamReleaseSkill[] {
  const skillsRoot = join(root, 'skills')
  if (!realDirectory(skillsRoot)) return []
  const skills: TeamReleaseSkill[] = []
  for (const entry of sortedEntries(skillsRoot)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const skillRoot = join(skillsRoot, entry.name)
    const skillPath = join(skillRoot, 'SKILL.md')
    if (!regularFile(skillPath)) throw new Error(`skills/${entry.name}/SKILL.md is required`)
    const source = readFileSync(skillPath, 'utf-8')
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1]
    if (!frontmatter) throw new Error(`skills/${entry.name}/SKILL.md must start with frontmatter`)
    const name = scalar(frontmatter, 'name')
    if (name !== entry.name) throw new Error(`skills/${entry.name}/SKILL.md name must match its folder`)
    const description = requiredString(
      scalar(frontmatter, 'description'),
      `skills/${entry.name}/SKILL.md description`,
    )
    const version = requiredVersion(
      scalar(frontmatter, 'version'),
      `skills/${entry.name}/SKILL.md version`,
    )
    skills.push({
      id: entry.name,
      name,
      description,
      version,
      digest: digestTree(skillRoot, path => path === 'SKILL.md'
        ? source.replace(/^version:\s*.+?\s*$/m, 'version:')
        : undefined),
    })
  }
  return skills
}

function collectPathEntries(root: string): TeamReleasePath[] {
  if (!realDirectory(root)) return []
  return collectFiles(root).map(file => ({
    path: file.path,
    digest: sha256(readFileSync(file.absolutePath)),
  }))
}

function digestTree(root: string, normalize: (path: string) => string | undefined): string {
  const hash = createHash('sha256')
  for (const file of collectFiles(root)) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(normalize(file.path) ?? readFileSync(file.absolutePath))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function collectFiles(root: string): Array<{ path: string; absolutePath: string }> {
  const files: Array<{ path: string; absolutePath: string }> = []
  const visit = (current: string) => {
    for (const entry of sortedEntries(current)) {
      if (IGNORED_NAMES.has(entry.name) || entry.name === '.gitkeep') continue
      const absolutePath = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Team releases cannot contain symbolic links: ${relative(root, absolutePath)}`)
      }
      if (entry.isDirectory()) visit(absolutePath)
      else if (entry.isFile()) {
        files.push({
          path: relative(root, absolutePath).split(sep).join('/'),
          absolutePath,
        })
      }
    }
  }
  visit(root)
  return files
}

function normalizedAppManifest(source: string): string {
  const pkg = JSON.parse(source) as Record<string, unknown>
  delete pkg.version
  return JSON.stringify(sortObject(pkg))
}

function scalar(source: string, key: string): string | undefined {
  return source.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))?.[1]
    ?.replace(/^(['"])(.*)\1$/, '$2')
    .trim()
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function requiredVersion(value: unknown, label: string): string {
  const version = requiredString(value, label)
  if (!VERSION.test(version)) throw new Error(`${label} must use major.minor.patch`)
  return version
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sortObject(value: Record<string, unknown>): Record<string, unknown>
function sortObject(value: unknown): unknown
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObject(entry)]),
  )
}

function sortedEntries(path: string) {
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function realDirectory(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return stat.isDirectory() && !stat.isSymbolicLink()
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
