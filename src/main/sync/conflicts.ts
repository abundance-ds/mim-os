import { execFile, execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface SyncStop {
  message: string
  conflicts: string[]
  retryable: boolean
  at: string
}

export function readSyncStop(path: string): SyncStop | null {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SyncStop>
    if (
      typeof value.message !== 'string'
      || !Array.isArray(value.conflicts)
      || !value.conflicts.every(item => typeof item === 'string')
      || typeof value.retryable !== 'boolean'
      || typeof value.at !== 'string'
    ) return null
    return value as SyncStop
  } catch {
    return null
  }
}

export function writeSyncStop(
  path: string,
  stop: Omit<SyncStop, 'at'>,
): SyncStop {
  const value = { ...stop, at: new Date().toISOString() }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return value
}

export function clearSyncStop(path: string): void {
  rmSync(path, { force: true })
}

export function isRetryableGitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return [
    /could not resolve host/i,
    /connection (?:timed out|reset|refused)/i,
    /network is unreachable/i,
    /temporary failure in name resolution/i,
    /unable to access .* failed to connect/i,
    /remote end hung up unexpectedly/i,
    /could not read from remote repository/i,
    /ssh: connect to host .* (?:timed out|no route to host)/i,
  ].some(pattern => pattern.test(message))
}

/**
 * Preserve both sides of every conflict created by `git pull --rebase`.
 * During a rebase, stage 2 is the fetched remote version and stage 3 is the
 * local commit being replayed. The rebase is aborted before the copies are
 * written, so the original path returns to the user's local version.
 */
export async function preserveRebaseConflicts(
  root: string,
  markerPath: string,
  label: string,
): Promise<SyncStop | null> {
  const conflicts = gitOutput(root, ['diff', '--name-only', '--diff-filter=U'])
    .split('\n')
    .filter(Boolean)
  if (conflicts.length === 0) return null

  const captured = conflicts.map((path) => ({
    path,
    remote: gitBuffer(root, ['show', `:2:${path}`]),
    local: gitBuffer(root, ['show', `:3:${path}`]),
  }))
  await execFileAsync('git', ['-C', root, 'rebase', '--abort'], {
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
  })

  const copies: string[] = []
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  for (const item of captured) {
    const target = safePath(root, item.path)
    const extension = extname(target)
    const stem = basename(target, extension)
    const parent = dirname(target)
    mkdirSync(parent, { recursive: true })
    for (const [side, content] of [['local', item.local], ['remote', item.remote]] as const) {
      const copy = uniqueCopyPath(parent, `${stem}.conflict-${side}-${stamp}${extension}`)
      writeFileSync(copy, content)
      copies.push(relative(root, copy))
    }
  }

  return writeSyncStop(markerPath, {
    message: `${label} update paused. Mim preserved both versions as ${copies.join(' and ')}. Keep the version you want, then try again.`,
    conflicts: copies,
    retryable: false,
  })
}

function gitOutput(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' }).trimEnd()
}

function gitBuffer(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'buffer' })
}

function safePath(root: string, path: string): string {
  const resolvedRoot = resolve(root)
  const target = resolve(root, path)
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Git reported an unsafe conflict path: ${path}`)
  }
  return target
}

function uniqueCopyPath(parent: string, name: string): string {
  const extension = extname(name)
  const stem = basename(name, extension)
  let candidate = join(parent, name)
  let suffix = 2
  while (existsSync(candidate)) {
    candidate = join(parent, `${stem}-${suffix}${extension}`)
    suffix += 1
  }
  return candidate
}
