import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WebSocket } from 'ws'
import { createServer, MCP_TOOL_SPECS, resolvePackageUiPath, resolveSdkDirFromRoots } from '@main/server/server.js'
import type { LoadedPackage, PackageLoader } from '@main/packages/packages.js'
import type { ToolContext, ToolDef, ToolRegistry } from '@main/tools/registry.js'

describe('app server', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof createServer>> | null
  let sockets: WebSocket[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-server-test-'))
    server = null
    sockets = []
  })

  afterEach(() => {
    for (const socket of sockets) socket.close()
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function addPackage(id = 'pkg'): LoadedPackage {
    const pkgDir = join(dir, id)
    mkdirSync(join(pkgDir, 'ui'), { recursive: true })
    writeFileSync(join(pkgDir, 'ui', 'index.html'), '<h1>Package UI</h1>')
    return {
      manifest: {
        manifestVersion: 1,
        id,
        name: 'Package',
        version: '0.1.0',
        views: [{ id: 'main', label: 'Package', src: './ui/index.html', role: 'work' }],
        permissions: {},
      },
      dir: pkgDir,
      source: 'project',
      hasReadme: false,
    }
  }

  function makePackages(packages: LoadedPackage[]): PackageLoader {
    return {
      list: () => packages,
      get: (id) => packages.find((pkg) => pkg.manifest.id === id),
      diagnostics: () => [],
      onChange: () => undefined,
      rescan: async () => undefined,
    }
  }

  function makeTools(
    call = vi.fn(async () => ({ ok: true })),
    workspacePath: string | null = null,
    toolDefs: ToolDef[] = [],
  ): ToolRegistry {
    return {
      register: (_tool: ToolDef) => undefined,
      call,
      list: () => toolDefs,
      get: (name) => toolDefs.find(tool => tool.name === name),
      getWorkspacePath: () => workspacePath,
      setWorkspacePath: () => undefined,
    }
  }

  function makeMcpToolDefs(): ToolDef[] {
    return MCP_TOOL_SPECS.map(spec => ({
      name: spec.mimName,
      description: spec.description,
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    }))
  }

  async function openSocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(socket)
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once('open', resolveOpen)
      socket.once('error', rejectOpen)
    })
    return socket
  }

  async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
    const raw = await new Promise<WebSocket.RawData>((resolveMessage) => {
      socket.once('message', resolveMessage)
    })
    return JSON.parse(raw.toString()) as Record<string, unknown>
  }

  async function sendJson(socket: WebSocket, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    socket.send(JSON.stringify(message))
    return nextMessage(socket)
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Timed out waiting for condition')
  }

  it('serves app UI files from the app ui directory', async () => {
    const pkg = addPackage()
    server = await createServer(makeTools(), makePackages([pkg]))

    const response = await fetch(`http://127.0.0.1:${server.port}/packages/pkg/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Package UI')
  })

  it('serves app UI even when its origin path contains a dot-directory', async () => {
    // A dot-segment in any direct origin makes sendFile's default
    // dotfiles:'ignore' policy 404 the whole path unless we serve relative to
    // the ui/ root.
    const pkgDir = join(dir, '.mim', 'packages', 'dotpkg', '0.1.0')
    mkdirSync(join(pkgDir, 'ui'), { recursive: true })
    writeFileSync(join(pkgDir, 'ui', 'index.html'), '<h1>Dot UI</h1>')
    const pkg: LoadedPackage = {
      manifest: {
        manifestVersion: 1,
        id: 'dotpkg',
        name: 'Dot Package',
        version: '0.1.0',
        views: [{ id: 'main', label: 'Dot', src: './ui/index.html', role: 'work' }],
        permissions: {},
      },
      dir: pkgDir,
      source: 'mim',
      hasReadme: false,
    }
    server = await createServer(makeTools(), makePackages([pkg]))

    const response = await fetch(`http://127.0.0.1:${server.port}/packages/dotpkg/index.html`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Dot UI')
  })

  it('serves browser SDK assets with real MIME types', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))

    const js = await fetch(`http://127.0.0.1:${server.port}/sdk/mim.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toMatch(/javascript/)
    expect(await js.text()).toContain('export const runtime')

    const css = await fetch(`http://127.0.0.1:${server.port}/sdk/tokens.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(await css.text()).toContain('--color-ink')
  })

  it('resolves SDK assets from the packaged app.asar layout', () => {
    const root = join(dir, 'resources')
    const sdkDir = join(root, 'app.asar', 'sdk')
    mkdirSync(sdkDir, { recursive: true })
    writeFileSync(join(sdkDir, 'mim.js'), 'export const runtime = {}')
    writeFileSync(join(sdkDir, 'tokens.css'), ':root { --color-ink: #111; }')

    expect(resolveSdkDirFromRoots([root])).toBe(sdkDir)
  })

  it('serves workspace files for artifact viewers, scoped to the workspace', async () => {
    const workspace = join(dir, 'workspace')
    mkdirSync(join(workspace, 'outputs'), { recursive: true })
    writeFileSync(join(workspace, 'outputs', 'deck.pdf'), '%PDF-1.4 fake')
    writeFileSync(join(dir, 'outside.txt'), 'secret')
    server = await createServer(makeTools(undefined, workspace), makePackages([addPackage()]))

    const ok = await fetch(`http://127.0.0.1:${server.port}/workspace-files/outputs/deck.pdf`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('application/pdf')
    expect(await ok.text()).toContain('%PDF-1.4 fake')

    const traversal = await fetch(`http://127.0.0.1:${server.port}/workspace-files/..%2Foutside.txt`)
    expect(traversal.status).toBe(404)

    const missing = await fetch(`http://127.0.0.1:${server.port}/workspace-files/outputs/none.pdf`)
    expect(missing.status).toBe(404)

    const directory = await fetch(`http://127.0.0.1:${server.port}/workspace-files/outputs`)
    expect(directory.status).toBe(404)
  })

  it('returns 404 for workspace files when no workspace is open', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))
    const response = await fetch(`http://127.0.0.1:${server.port}/workspace-files/notes.md`)
    expect(response.status).toBe(404)
  })

  it('returns 404 for routine webhooks when no handler is registered', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))

    const response = await fetch(`http://127.0.0.1:${server.port}/api/hooks/pulse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, error: 'Routine webhooks are not available' })
  })

  it('delegates routine webhooks with raw body and signing headers', async () => {
    const handleRoutineWebhook = vi.fn(async () => ({ status: 202, ok: true, duplicate: true }))
    server = await createServer(makeTools(), makePackages([addPackage()]), { handleRoutineWebhook })
    const rawBody = '{"z":1,"message":"hello"}'

    const response = await fetch(`http://127.0.0.1:${server.port}/api/hooks/incoming-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mim-timestamp': '2026-07-08T12:00:00.000Z',
        'x-mim-signature': 'sha256=abc123',
        'x-mim-delivery': 'delivery-1',
      },
      body: rawBody,
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true, duplicate: true })
    expect(handleRoutineWebhook).toHaveBeenCalledOnce()
    const [name, delivery] = handleRoutineWebhook.mock.calls[0]
    expect(name).toBe('incoming-report')
    expect(delivery.rawBody.toString('utf-8')).toBe(rawBody)
    expect(delivery.body).toEqual({ z: 1, message: 'hello' })
    expect(delivery.headers['x-mim-timestamp']).toBe('2026-07-08T12:00:00.000Z')
    expect(delivery.headers['x-mim-signature']).toBe('sha256=abc123')
    expect(delivery.headers['x-mim-delivery']).toBe('delivery-1')
  })

  it('resolves app UI paths without allowing sibling-prefix traversal', () => {
    const pkg = addPackage()
    mkdirSync(join(pkg.dir, 'ui-evil'), { recursive: true })
    writeFileSync(join(pkg.dir, 'ui-evil', 'secret.txt'), 'do not serve')

    expect(resolvePackageUiPath(pkg.dir, '/index.html')).toBe(join(pkg.dir, 'ui', 'index.html'))
    expect(resolvePackageUiPath(pkg.dir, '/../ui-evil/secret.txt')).toBeNull()
    expect(resolvePackageUiPath(pkg.dir, '/../../outside.txt')).toBeNull()
  })

  it('returns a WebSocket error for invalid JSON', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))
    const socket = await openSocket(server.port)

    socket.send('{bad json')
    await expect(nextMessage(socket)).resolves.toEqual({ error: 'Invalid JSON' })
  })

  it('creates launch-token package URLs', async () => {
    const pkg = addPackage()
    server = await createServer(makeTools(), makePackages([pkg]))

    const url = new URL(server.createPackageLaunchUrl('pkg'))

    expect(url.pathname).toBe('/packages/pkg/index.html')
    expect(url.searchParams.get('launch')).toBeTruthy()
  })

  it('routes package WebSocket calls through the tool registry with package context', async () => {
    const call = vi.fn(async (_name: string, _params: Record<string, unknown>, _ctx: ToolContext) => ({
      content: 'result',
    }))
    server = await createServer(makeTools(call), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const launch = new URL(server.createPackageLaunchUrl('pkg')).searchParams.get('launch')

    const identify = await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { launch },
    })
    expect(identify.id).toBe('identify-1')
    expect(identify.result).toMatchObject({ clientId: expect.any(String), packageId: 'pkg' })

    const result = await sendJson(socket, {
      id: 'read-1',
      method: 'fs.read',
      params: { path: 'notes.md' },
    })

    expect(result).toEqual({ id: 'read-1', result: { content: 'result' } })
    expect(call).toHaveBeenCalledWith('fs.read', { path: 'notes.md' }, {
      actor: 'package',
      package_id: 'pkg',
    })
  })

  it('returns package lists over WebSocket to identified connections without invoking tools', async () => {
    const call = vi.fn()
    const pkg = addPackage('workspace-pkg')
    server = await createServer(makeTools(call), makePackages([pkg]))
    const socket = await openSocket(server.port)
    const launch = new URL(server.createPackageLaunchUrl('workspace-pkg')).searchParams.get('launch')
    await sendJson(socket, { id: 'identify-1', method: 'identify', params: { launch } })

    const result = await sendJson(socket, { id: 'packages-1', method: 'packages.list' })

    expect(result.id).toBe('packages-1')
    expect(result.result).toEqual([pkg])
    expect(call).not.toHaveBeenCalled()
  })

  it('identifies MCP sockets and returns the curated tool catalog', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-1')

    const identify = await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })
    expect(identify).toMatchObject({
      id: 'identify-1',
      result: { type: 'mcp', sessionId: 'agent-session-1' },
    })

    const meta = await sendJson(socket, { id: 'meta-1', method: '__meta.tools' })

    expect(call).not.toHaveBeenCalled()
    expect(meta.id).toBe('meta-1')
    const tools = (meta.result as { tools: Array<Record<string, unknown>> }).tools
    expect(tools).toHaveLength(MCP_TOOL_SPECS.length)
    expect(tools[0]).toEqual({
      name: 'editor_open',
      mimName: 'editor.open',
      description: 'Open a file in the editor',
      inputSchema: { type: 'object', properties: {} },
    })
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'browser_open',
        mimName: 'web.live.open',
        description: 'Open Mim\'s live browser for interactive websites or localhost development servers',
      }),
      expect.objectContaining({
        name: 'browser_act',
        mimName: 'web.live.act',
        description: 'Observe or act in the live browser session',
      }),
    ]))
  })

  it('filters disabled MCP tools from metadata and direct execution', async () => {
    mkdirSync(join(dir, '.mim'), { recursive: true })
    writeFileSync(join(dir, '.mim', 'settings.json'), JSON.stringify({
      tools: { disabled: ['editor.open'] },
    }))
    const call = vi.fn(async (_name: string) => ({ ok: true }))
    server = await createServer(makeTools(call, dir, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-disabled')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const meta = await sendJson(socket, { id: 'meta-1', method: '__meta.tools' })
    const tools = (meta.result as { tools: Array<{ name: string; mimName: string }> }).tools
    expect(tools.some(tool => tool.name === 'editor_open')).toBe(false)

    const denied = await sendJson(socket, {
      id: 'open-1',
      method: 'editor.open',
      params: { path: 'README.md' },
    })
    expect(denied).toEqual({ id: 'open-1', error: 'Tool is not exposed over MCP: editor.open' })
    expect(call).not.toHaveBeenCalled()
  })

  it('omits unregistered static MCP tools instead of returning broken catalog entries', async () => {
    const call = vi.fn()
    const registeredToolDefs = MCP_TOOL_SPECS
      .filter(spec => spec.mimName === 'fs.read' || spec.mimName === 'workspace.info')
      .map(spec => ({
        name: spec.mimName,
        description: spec.description,
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ ok: true }),
      }))
    server = await createServer(makeTools(call, null, registeredToolDefs), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('headless-catalog')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const meta = await sendJson(socket, { id: 'meta-1', method: '__meta.tools' })

    expect(call).not.toHaveBeenCalled()
    expect(meta.id).toBe('meta-1')
    const tools = (meta.result as { tools: Array<{ mimName: string }> }).tools
    expect(tools.map(tool => tool.mimName)).toEqual(['fs.read', 'workspace.info'])
  })

  it('prevents MCP clients from rewriting the tool policy through settings.set', async () => {
    const call = vi.fn(async (_name: string) => ({ ok: true }))
    server = await createServer(makeTools(call, dir, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-settings')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const denied = await sendJson(socket, {
      id: 'settings-1',
      method: 'settings.set',
      params: { key: 'tools', value: { disabled: [] } },
    })

    expect(denied).toEqual({ id: 'settings-1', error: 'Tool policy cannot be changed over MCP' })
    expect(call).not.toHaveBeenCalled()
  })

  it('prevents MCP clients from writing legacy connectors settings key', async () => {
    const call = vi.fn(async (_name: string) => ({ ok: true }))
    server = await createServer(makeTools(call, dir, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-connectors')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const denied = await sendJson(socket, {
      id: 'settings-2',
      method: 'settings.set',
      params: { key: 'connectors', value: { slack: { aiEnabled: true } } },
    })

    expect(denied).toEqual({ id: 'settings-2', error: 'Tool policy cannot be changed over MCP' })
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses MCP metadata before identification', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)

    const result = await sendJson(socket, { id: 'meta-1', method: '__meta.tools' })

    expect(result).toEqual({ id: 'meta-1', error: 'Connection is not identified' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects invalid MCP tokens and does not bind identity', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)

    const identify = await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token: 'bad-token' },
    })
    expect(identify).toEqual({ id: 'identify-1', error: 'Invalid MCP token' })

    const result = await sendJson(socket, { id: 'meta-1', method: '__meta.tools' })
    expect(result).toEqual({ id: 'meta-1', error: 'Connection is not identified' })
    expect(call).not.toHaveBeenCalled()
  })

  it('revokes MCP tokens for future identifies and closes active MCP sockets', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const token = server.createMcpToken('agent-session-revoked')
    const socket = await openSocket(server.port)
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const closed = new Promise<{ code: number; reason: string }>((resolveClose) => {
      socket.once('close', (code, reason) => {
        resolveClose({ code, reason: reason.toString() })
      })
    })
    server.revokeMcpToken(token)

    await expect(closed).resolves.toEqual({ code: 1008, reason: 'MCP token revoked' })

    const second = await openSocket(server.port)
    const identify = await sendJson(second, {
      id: 'identify-2',
      method: 'identify',
      params: { type: 'mcp', token },
    })
    expect(identify).toEqual({ id: 'identify-2', error: 'Invalid MCP token' })
  })

  it('routes MCP tool calls as the local user with the MCP session id and enforces the server allowlist', async () => {
    const call = vi.fn(async (_name: string) => ({ ok: true }))
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-2')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const allowed = await sendJson(socket, {
      id: 'open-1',
      method: 'editor.open',
      params: { path: 'README.md' },
    })
    const browser = await sendJson(socket, {
      id: 'browser-1',
      method: 'web.live.open',
      params: { url: 'http://localhost:4567', visible: true },
    })
    const denied = await sendJson(socket, {
      id: 'write-1',
      method: 'fs.write',
      params: { path: 'README.md', content: 'hacked' },
    })

    expect(allowed).toEqual({ id: 'open-1', result: { ok: true } })
    expect(browser).toEqual({ id: 'browser-1', result: { ok: true } })
    expect(denied).toEqual({ id: 'write-1', error: 'Tool is not exposed over MCP: fs.write' })
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenNthCalledWith(1, 'editor.open', { path: 'README.md' }, {
      actor: 'user',
      sessionId: 'agent-session-2',
    })
    expect(call).toHaveBeenNthCalledWith(2, 'web.live.open', { url: 'http://localhost:4567', visible: true }, {
      actor: 'user',
      sessionId: 'agent-session-2',
    })
  })

  it('keeps packages.list package-only after MCP identification', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-3')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const result = await sendJson(socket, { id: 'packages-1', method: 'packages.list' })

    expect(result).toEqual({ id: 'packages-1', error: 'Method is not available for MCP connections' })
    expect(call).not.toHaveBeenCalled()
  })

  it('attributes MCP tool calls to the reported client name', async () => {
    const call = vi.fn(async () => ({ ok: true }))
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-5')
    await sendJson(socket, { id: 'identify-1', method: 'identify', params: { type: 'mcp', token } })

    const meta = await sendJson(socket, { id: 'client-1', method: '__meta.client', params: { name: 'claude-code' } })
    await sendJson(socket, { id: 'open-1', method: 'editor.open', params: { path: 'README.md' } })

    expect(meta).toEqual({ id: 'client-1', result: { ok: true } })
    expect(call).toHaveBeenCalledWith('editor.open', { path: 'README.md' }, {
      actor: 'user',
      sessionId: 'agent-session-5',
      agent: 'claude-code',
    })
  })

  it('exposes dynamic named tools over MCP alongside core tools', async () => {
    const call = vi.fn(async () => ({ rows: [] }))
    const namedTool: ToolDef = {
      name: 'issues.list',
      description: 'List project issues',
      inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
      execute: async () => ({ rows: [] }),
    }
    const toolDefs = [...makeMcpToolDefs(), namedTool]
    const getNamedMcpTools = () => [
      { name: 'issues_list', mimName: 'issues.list', description: 'List project issues' },
    ]
    server = await createServer(makeTools(call, null, toolDefs), makePackages([addPackage()]), { getNamedMcpTools })
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('named-test')
    await sendJson(socket, { id: 'id-1', method: 'identify', params: { type: 'mcp', token } })

    const meta = await sendJson(socket, { id: 'meta-1', method: '__meta.tools' })
    const tools = (meta.result as { tools: Array<{ name: string }> }).tools
    expect(tools).toHaveLength(MCP_TOOL_SPECS.length + 1)
    expect(tools.find(t => t.name === 'issues_list')).toMatchObject({
      name: 'issues_list',
      mimName: 'issues.list',
      description: 'List project issues',
    })

    const result = await sendJson(socket, {
      id: 'issues-1',
      method: 'issues.list',
      params: { status: 'open' },
    })
    expect(result).toEqual({ id: 'issues-1', result: { rows: [] } })
    expect(call).toHaveBeenCalledWith('issues.list', { status: 'open' }, {
      actor: 'user',
      sessionId: 'named-test',
    })
  })

  it('skips named tools without inputSchema in the MCP catalog', async () => {
    const call = vi.fn(async () => ({}))
    const noSchemaTool: ToolDef = {
      name: 'broken.tool',
      description: 'Missing schema',
      execute: async () => ({}),
    }
    const toolDefs = [...makeMcpToolDefs(), noSchemaTool]
    const getNamedMcpTools = () => [
      { name: 'broken_tool', mimName: 'broken.tool', description: 'Missing schema' },
    ]
    server = await createServer(makeTools(call, null, toolDefs), makePackages([addPackage()]), { getNamedMcpTools })
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('schema-test')
    await sendJson(socket, { id: 'id-1', method: 'identify', params: { type: 'mcp', token } })

    const meta = await sendJson(socket, { id: 'meta-1', method: '__meta.tools' })
    const tools = (meta.result as { tools: Array<{ name: string }> }).tools
    expect(tools).toHaveLength(MCP_TOOL_SPECS.length)
    expect(tools.find(t => t.name === 'broken_tool')).toBeUndefined()
  })

  it('does not allow an identified MCP socket to re-identify as a package', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-4')
    const launch = new URL(server.createPackageLaunchUrl('pkg')).searchParams.get('launch')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    const reidentify = await sendJson(socket, {
      id: 'identify-2',
      method: 'identify',
      params: { launch },
    })
    const denied = await sendJson(socket, {
      id: 'write-1',
      method: 'fs.write',
      params: { path: 'README.md', content: 'hacked' },
    })

    expect(reidentify).toEqual({ id: 'identify-2', error: 'Connection is already identified' })
    expect(denied).toEqual({ id: 'write-1', error: 'Tool is not exposed over MCP: fs.write' })
    expect(call).not.toHaveBeenCalled()
  })

  it('does not throw if a client disconnects while an async tool call is pending', async () => {
    let resolveTool!: (value: unknown) => void
    const call = vi.fn(() => new Promise(resolve => { resolveTool = resolve }))
    server = await createServer(makeTools(call, null, makeMcpToolDefs()), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const token = server.createMcpToken('agent-session-disconnect')
    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { type: 'mcp', token },
    })

    socket.send(JSON.stringify({
      id: 'open-1',
      method: 'editor.open',
      params: { path: 'README.md' },
    }))
    await waitFor(() => call.mock.calls.length === 1)
    const closed = new Promise<void>((resolveClose) => socket.once('close', () => resolveClose()))
    socket.close()
    await closed

    resolveTool({ ok: true })
    await new Promise(resolve => setImmediate(resolve))

    const second = await openSocket(server.port)
    await expect(sendJson(second, {
      id: 'identify-2',
      method: 'identify',
      params: { type: 'mcp', token },
    })).resolves.toMatchObject({ id: 'identify-2', result: { type: 'mcp' } })
  })

  it('closes active WebSocket clients when the desktop server shuts down', async () => {
    server = await createServer(makeTools(), makePackages([]))
    const socket = await openSocket(server.port)
    const closed = new Promise<void>(resolveClose => socket.once('close', () => resolveClose()))

    server.close()

    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })

  it('refuses packages.list before identification so foreign pages cannot enumerate packages', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call), makePackages([addPackage()]))
    const socket = await openSocket(server.port)

    const result = await sendJson(socket, { id: 'packages-1', method: 'packages.list' })

    expect(result).toEqual({ id: 'packages-1', error: 'Connection is not identified' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects tool calls before a package connection is identified', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call), makePackages([addPackage()]))
    const socket = await openSocket(server.port)

    const result = await sendJson(socket, {
      id: 'read-1',
      method: 'fs.read',
      params: { path: 'notes.md' },
    })

    expect(result).toEqual({ id: 'read-1', error: 'Connection is not identified' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects invalid launch tokens and does not bind identity', async () => {
    const call = vi.fn()
    server = await createServer(makeTools(call), makePackages([addPackage()]))
    const socket = await openSocket(server.port)

    const identify = await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { launch: 'bad-token' },
    })
    expect(identify).toEqual({ id: 'identify-1', error: 'Invalid app launch token' })

    const result = await sendJson(socket, {
      id: 'read-1',
      method: 'fs.read',
      params: { path: 'notes.md' },
    })
    expect(result).toEqual({ id: 'read-1', error: 'Connection is not identified' })
    expect(call).not.toHaveBeenCalled()
  })

  it('allows a launch token to be reused while it is valid for iframe reloads', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))
    const launch = new URL(server.createPackageLaunchUrl('pkg')).searchParams.get('launch')
    const first = await openSocket(server.port)
    const second = await openSocket(server.port)

    await expect(sendJson(first, {
      id: 'identify-1',
      method: 'identify',
      params: { launch },
    })).resolves.toMatchObject({ id: 'identify-1', result: { packageId: 'pkg' } })

    await expect(sendJson(second, {
      id: 'identify-2',
      method: 'identify',
      params: { launch },
    })).resolves.toMatchObject({ id: 'identify-2', result: { packageId: 'pkg' } })
  })

  it('keeps an identified launch token valid past the initial window so iframe remounts reconnect cleanly', async () => {
    // The work pane keeps the package iframe URL alive indefinitely (KeepAlive);
    // navigating back reloads the iframe with the same launch token long after mint.
    const call = vi.fn(async () => ({ ok: true }))
    server = await createServer(makeTools(call), makePackages([addPackage()]))
    const launch = new URL(server.createPackageLaunchUrl('pkg')).searchParams.get('launch')

    const first = await openSocket(server.port)
    await expect(sendJson(first, {
      id: 'identify-1',
      method: 'identify',
      params: { launch },
    })).resolves.toMatchObject({ id: 'identify-1', result: { packageId: 'pkg' } })
    first.close()

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
    try {
      const second = await openSocket(server.port)
      await expect(sendJson(second, {
        id: 'identify-2',
        method: 'identify',
        params: { launch },
      })).resolves.toMatchObject({ id: 'identify-2', result: { packageId: 'pkg' } })

      const result = await sendJson(second, {
        id: 'read-1',
        method: 'fs.read',
        params: { path: 'notes.md' },
      })
      expect(result).toEqual({ id: 'read-1', result: { ok: true } })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('expires launch tokens that were never identified', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))
    const launch = new URL(server.createPackageLaunchUrl('pkg')).searchParams.get('launch')

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
    try {
      const socket = await openSocket(server.port)
      await expect(sendJson(socket, {
        id: 'identify-1',
        method: 'identify',
        params: { launch },
      })).resolves.toEqual({ id: 'identify-1', error: 'Invalid app launch token' })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('sets CORS headers for same-origin and null origins only', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))

    const sameOrigin = await fetch(`http://127.0.0.1:${server.port}/packages/pkg/`, {
      headers: { Origin: `http://127.0.0.1:${server.port}` },
    })
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBe(
      `http://127.0.0.1:${server.port}`,
    )

    const nullOrigin = await fetch(`http://127.0.0.1:${server.port}/packages/pkg/`, {
      headers: { Origin: 'null' },
    })
    expect(nullOrigin.headers.get('access-control-allow-origin')).toBe('null')

    const foreignOrigin = await fetch(`http://127.0.0.1:${server.port}/packages/pkg/`, {
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(foreignOrigin.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('returns tool errors to the calling package', async () => {
    const call = vi.fn(async () => {
      throw new Error('disk full')
    })
    server = await createServer(makeTools(call), makePackages([addPackage()]))
    const socket = await openSocket(server.port)
    const launch = new URL(server.createPackageLaunchUrl('pkg')).searchParams.get('launch')

    await sendJson(socket, {
      id: 'identify-1',
      method: 'identify',
      params: { launch },
    })

    const result = await sendJson(socket, {
      id: 'write-1',
      method: 'fs.write',
      params: { path: 'out.md', content: 'data' },
    })

    expect(result).toEqual({ id: 'write-1', error: 'disk full' })
  })

  it('handles socket error events without crashing the server', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))
    const socket = await openSocket(server.port)

    // Simulate a socket-level error. The server should handle it gracefully
    // and keep serving other connections.
    socket.emit('error', new Error('simulated socket error'))

    // The server should still be operational — opening a new socket must work.
    const second = await openSocket(server.port)
    second.send(JSON.stringify({ id: 'ping', method: 'identify', params: { launch: 'bad' } }))
    const reply = await nextMessage(second)
    expect(reply.error).toBe('Invalid app launch token')
  })

  it('replays buffered events on reconnect when the client sends lastSeq', async () => {
    server = await createServer(makeTools(), makePackages([addPackage()]))

    // Broadcast some package job events to fill the buffer.
    server.broadcast('package:job:event', {
      type: 'job.step',
      packageId: 'pkg',
      jobId: 'build',
      runId: 'run-1',
      ts: '2026-06-11T00:00:00.000Z',
      sequence: 1,
      data: { name: 'Step 1' },
    })
    server.broadcast('package:job:event', {
      type: 'job.step',
      packageId: 'pkg',
      jobId: 'build',
      runId: 'run-1',
      ts: '2026-06-11T00:00:01.000Z',
      sequence: 2,
      data: { name: 'Step 2' },
    })
    server.broadcast('package:job:event', {
      type: 'job.done',
      packageId: 'pkg',
      jobId: 'build',
      runId: 'run-1',
      ts: '2026-06-11T00:00:02.000Z',
      sequence: 3,
      data: { result: { ok: true } },
    })

    // Reconnect with lastSeq=1 — should replay events with seq > 1.
    const socket = await openSocket(server.port)
    const launch = new URL(server.createPackageLaunchUrl('pkg')).searchParams.get('launch')

    // Collect all messages after sending identify.
    const messages: Record<string, unknown>[] = []
    const collected = new Promise<void>((resolve) => {
      let count = 0
      socket.on('message', (raw) => {
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>)
        count++
        // Expect 3 messages: identify result + 2 replayed events
        if (count >= 3) resolve()
      })
    })

    socket.send(JSON.stringify({
      id: 'identify-1',
      method: 'identify',
      params: { launch, lastSeq: 1 },
    }))

    await collected

    expect(messages[0]).toMatchObject({ id: 'identify-1', result: { packageId: 'pkg' } })
    expect(messages[1]).toMatchObject({
      event: 'package:job:event',
      data: { sequence: 2, data: { name: 'Step 2' } },
    })
    expect(messages[2]).toMatchObject({
      event: 'package:job:event',
      data: { sequence: 3, data: { result: { ok: true } } },
    })
  })
})
