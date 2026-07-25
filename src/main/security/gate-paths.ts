import { isAbsolute, relative, resolve, sep } from 'path'

export type PermissionPathKind = 'workspace' | 'team' | 'personal' | 'mim' | 'sensitive' | 'outside-workspace' | 'invalid'

export interface PermissionPathClassification {
  kind: PermissionPathKind
  reason: string
  absolutePath: string | null
  // The checkout mount itself is protected; contributions beneath it are
  // ordinary writable Team paths.
  isTeamRoot?: boolean
}

const SENSITIVE_LOCATIONS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.npmrc',
  '.pypirc',
  '/etc',
  '/private/etc',
  '/var/run',
  '/Library/Keychains',
]

const SENSITIVE_SEGMENTS = ['credentials', 'secrets']

// Segments that match by exact name (case-insensitive via lowercased segments).
const SENSITIVE_EXACT_SEGMENTS = [
  '.netrc',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
  '.bash_history',
  '.zsh_history',
]

// Segments that match by prefix: a path segment starting with this prefix is
// sensitive. E.g. `.env` matches `.env`, `.env.production`, `.env.local`.
const SENSITIVE_PREFIX_SEGMENTS = ['.env']

// SSH key filename patterns — match exact segment names that look like private
// keys or their public counterparts, even outside ~/.ssh.
const SENSITIVE_KEY_PATTERN = /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/

export function classifyPermissionPath(
  requestedPath: string | null | undefined,
  workspacePath: string | null,
): PermissionPathClassification {
  if (!requestedPath || requestedPath.trim().length === 0) {
    return { kind: 'invalid', reason: 'No path provided', absolutePath: null }
  }

  const base = workspacePath ? resolve(workspacePath) : null
  const absolutePath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(base ?? '/', requestedPath)

  const sensitiveLocation = findSensitiveLocation(absolutePath)
  if (sensitiveLocation) {
    return {
      kind: 'sensitive',
      reason: `Sensitive location: ${sensitiveLocation}`,
      absolutePath,
    }
  }

  const sensitiveSegment = findSensitiveSegment(absolutePath)
  if (sensitiveSegment) {
    return {
      kind: 'sensitive',
      reason: `Path contains sensitive segment: ${sensitiveSegment}`,
      absolutePath,
    }
  }

  if (!base) {
    return {
      kind: 'outside-workspace',
      reason: 'No workspace is open',
      absolutePath,
    }
  }

  if (isSameOrChildPath(absolutePath, base)) {
    const team = classifyTeamPath(absolutePath, base)
    if (team) return team
    const origin = classifyOriginPath(absolutePath, base)
    if (origin) return origin
    if (isEnablementLedger(absolutePath, base)) {
      return {
        kind: 'sensitive',
        reason: 'App enablement ledger',
        absolutePath,
      }
    }
    return {
      kind: 'workspace',
      reason: 'Within workspace',
      absolutePath,
    }
  }

  return {
    kind: 'outside-workspace',
    reason: 'Outside workspace',
    absolutePath,
  }
}

function classifyOriginPath(absolutePath: string, base: string): PermissionPathClassification | null {
  const segments = relative(base, absolutePath).split(sep)
  if (segments[0] !== '.mim' || segments[1] !== 'origins') return null
  if (segments[2] === 'you') {
    return {
      kind: 'personal',
      reason: 'Personal instructions or skills',
      absolutePath,
    }
  }
  if (segments[2] === 'mim') {
    return {
      kind: 'mim',
      reason: 'Mim built-in instructions or skills',
      absolutePath,
    }
  }
  return null
}

function findSensitiveLocation(absolutePath: string): string | null {
  for (const location of SENSITIVE_LOCATIONS) {
    if (location.startsWith('/')) {
      if (absolutePath === location || absolutePath.startsWith(`${location}${sep}`)) {
        return location
      }
      continue
    }

    if (
      absolutePath.endsWith(`${sep}${location}`) ||
      absolutePath.includes(`${sep}${location}${sep}`)
    ) {
      return location
    }
  }
  return null
}

function findSensitiveSegment(absolutePath: string): string | null {
  const segments = absolutePath.split(/[\\/]+/).map(segment => segment.toLowerCase())
  for (const sensitive of SENSITIVE_SEGMENTS) {
    if (segments.includes(sensitive)) return sensitive
  }
  for (const sensitive of SENSITIVE_EXACT_SEGMENTS) {
    if (segments.includes(sensitive)) return sensitive
  }
  for (const prefix of SENSITIVE_PREFIX_SEGMENTS) {
    for (const segment of segments) {
      if (segment === prefix || (segment.startsWith(prefix) && segment.charAt(prefix.length) === '.')) {
        return segment
      }
    }
  }
  for (const segment of segments) {
    if (SENSITIVE_KEY_PATTERN.test(segment)) return segment
  }
  return null
}

function classifyTeamPath(absolutePath: string, base: string): PermissionPathClassification | null {
  const segments = relative(base, absolutePath).split(sep)
  if (segments[0] !== '.mim' || segments[1] !== 'team') return null
  return {
    kind: 'team',
    reason: 'Connected Team',
    absolutePath,
    isTeamRoot: segments.length === 2,
  }
}

function isEnablementLedger(absolutePath: string, base: string): boolean {
  const rel = relative(base, absolutePath).split(sep)
  return rel.length === 3 && rel[0] === '.mim' && rel[1] === 'packages' && rel[2] === 'enabled.json'
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`)
}
