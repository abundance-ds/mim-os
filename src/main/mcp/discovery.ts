import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { userHomeDir } from '@main/platform.js'

export interface McpDiscovery {
  port: number
  token: string
}

export function mcpDiscoveryPath(home = defaultHome()): string {
  return join(home, '.mim', 'server.json')
}

export function writeMcpDiscoveryFile(value: McpDiscovery, home = defaultHome()): void {
  assertDiscovery(value)
  const path = mcpDiscoveryPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* best effort on filesystems without chmod */ }
    renameSync(tmp, path)
    try { chmodSync(path, 0o600) } catch { /* best effort on filesystems without chmod */ }
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* temp may not exist */ }
    throw err
  }
}

export function readMcpDiscoveryFile(home = defaultHome()): McpDiscovery {
  const path = mcpDiscoveryPath(home)
  if (!existsSync(path)) {
    throw new Error(`Mim desktop is not running; ${path} does not exist`)
  }
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<McpDiscovery>
  const discovery = {
    port: parsed.port,
    token: parsed.token,
  }
  assertDiscovery(discovery)
  return discovery
}

export function deleteMcpDiscoveryFile(home = defaultHome(), owner?: McpDiscovery): boolean {
  const path = mcpDiscoveryPath(home)
  if (owner) {
    try {
      const current = JSON.parse(readFileSync(path, 'utf-8')) as Partial<McpDiscovery>
      if (current.port !== owner.port || current.token !== owner.token) return false
    } catch {
      // A missing, malformed, or replaced record does not belong to this
      // desktop process and must not be removed.
      return false
    }
  }
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function assertDiscovery(value: Partial<McpDiscovery>): asserts value is McpDiscovery {
  if (!Number.isInteger(value.port) || value.port <= 0 || value.port > 65535) {
    throw new Error('MCP discovery port must be a valid TCP port')
  }
  if (typeof value.token !== 'string' || value.token.length < 16) {
    throw new Error('MCP discovery token must be a non-empty bearer token')
  }
}

function defaultHome(): string {
  return userHomeDir()
}
