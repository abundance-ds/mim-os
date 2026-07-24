import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteMcpDiscoveryFile,
  mcpDiscoveryPath,
  readMcpDiscoveryFile,
  writeMcpDiscoveryFile,
  type McpDiscovery,
} from './discovery.js'

describe('MCP discovery ownership', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mim-mcp-discovery-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('does not let an older desktop process delete a newer process discovery record', () => {
    const older: McpDiscovery = { port: 41001, token: 'older-desktop-token' }
    const newer: McpDiscovery = { port: 41002, token: 'newer-desktop-token' }
    writeMcpDiscoveryFile(older, home)
    writeMcpDiscoveryFile(newer, home)

    expect(deleteMcpDiscoveryFile(home, older)).toBe(false)
    expect(readMcpDiscoveryFile(home)).toEqual(newer)

    expect(deleteMcpDiscoveryFile(home, newer)).toBe(true)
    expect(existsSync(mcpDiscoveryPath(home))).toBe(false)
  })
})
