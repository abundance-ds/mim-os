import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { findWorkspaceRoot, parseArgs, runCli } from '@main/cli.js'
import type { PermissionApprovalRequest } from '@main/security/gate.js'

describe('mim CLI', () => {
  const originalHome = process.env.HOME
  let dir: string
  let home: string
  let stdout: string[]
  let stderr: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-cli-'))
    home = mkdtempSync(join(tmpdir(), 'mim-cli-home-'))
    process.env.HOME = home
    stdout = []
    stderr = []
  })

  afterEach(() => {
    process.env.HOME = originalHome
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  function io(cwd = dir, stdin?: string, options: {
    isTTY?: boolean
    confirmApproval?: (request: PermissionApprovalRequest) => Promise<boolean>
    runMcp?: () => Promise<number>
    platform?: NodeJS.Platform
    spawn?: any
    waitForShutdown?: () => Promise<void>
    runPackageTui?: (kernel: unknown, packageId: string) => Promise<number>
  } = {}) {
    return {
      cwd,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      stdin: stdin === undefined ? undefined : async () => stdin,
      isTTY: options.isTTY,
      confirmApproval: options.confirmApproval,
      runMcp: options.runMcp,
      platform: options.platform,
      spawn: options.spawn,
      waitForShutdown: options.waitForShutdown,
      runPackageTui: options.runPackageTui,
    }
  }

  it('parses global workspace and json flags', () => {
    expect(parseArgs(['--workspace', 'demo', '--json', 'status'])).toEqual({
      command: 'status',
      args: [],
      workspace: 'demo',
      json: true,
      yes: false,
    })
  })

  it('advertises local MCP without retired network collaboration commands', async () => {
    expect(await runCli(['help'], io())).toBe(0)

    const help = stdout.join('')
    expect(help).toContain('mim mcp')
    expect(help).toContain('mim tui <app>')
    expect(help).toContain('mim k')
    expect(help).not.toContain('mim serve')
    expect(help).not.toContain('shared-workspace')
  })

  it('launches a package terminal interface in the resolved workspace', async () => {
    writeFileSync(join(dir, 'mim.yaml'), 'name: tui-project\n')
    const launches: string[] = []

    const code = await runCli(['tui', 'knowledge'], io(dir, undefined, {
      isTTY: true,
      runPackageTui: async (kernel, packageId) => {
        launches.push(packageId)
        expect((kernel as { tools: { getWorkspacePath(): string | null } }).tools.getWorkspacePath()).toBe(dir)
        return 9
      },
    }))

    expect(code).toBe(9)
    expect(launches).toEqual(['knowledge'])
  })

  it('provides mim k as the Knowledge TUI shortcut', async () => {
    writeFileSync(join(dir, 'mim.yaml'), 'name: tui-project\n')
    const launches: string[] = []

    const code = await runCli(['k'], io(dir, undefined, {
      isTTY: true,
      runPackageTui: async (_kernel, packageId) => {
        launches.push(packageId)
        return 0
      },
    }))

    expect(code).toBe(0)
    expect(launches).toEqual(['knowledge'])
  })

  it('requires an interactive terminal for package TUIs', async () => {
    writeFileSync(join(dir, 'mim.yaml'), 'name: tui-project\n')

    const code = await runCli(['tui', 'knowledge'], io(dir, undefined, {
      isTTY: false,
      runPackageTui: async () => 0,
    }))

    expect(code).toBe(1)
    expect(stderr.join('')).toContain('interactive terminal')
  })

  it('parses the explicit approval flag', () => {
    expect(parseArgs(['tool', 'fs.delete', '{"path":"a.md"}', '--yes'])).toEqual({
      command: 'tool',
      args: ['fs.delete', '{"path":"a.md"}'],
      workspace: undefined,
      json: false,
      yes: true,
    })
  })

  it('preserves external command flags after the go separator', () => {
    expect(parseArgs(['go', '--workspace', 'demo', '--', 'agent', '--json', '--workspace', 'inner'])).toEqual({
      command: 'go',
      args: ['--', 'agent', '--json', '--workspace', 'inner'],
      workspace: 'demo',
      json: false,
      yes: false,
    })
  })

  it('reports a missing workspace flag value', async () => {
    const code = await runCli(['status', '--workspace'], io())

    expect(code).toBe(1)
    expect(stderr.join('')).toContain('Missing value for --workspace')
  })

  it('finds a workspace root by walking upward', () => {
    writeFileSync(join(dir, 'mim.yaml'), 'name: demo\n')
    const nested = join(dir, 'a/b/c')
    expect(findWorkspaceRoot(nested)).toBe(dir)
  })

  it('initializes a workspace', async () => {
    const code = await runCli(['init', '--name', 'demo'], io())

    expect(code).toBe(0)
    expect(existsSync(join(dir, 'mim.yaml'))).toBe(true)
    expect(readFileSync(join(dir, 'mim.yaml'), 'utf-8')).toContain('name: demo')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    expect(stdout.join('')).toContain('initialized')
  })

  it('orients the current workspace', async () => {
    await runCli(['init', '--name', 'demo'], io())
    stdout = []

    const code = await runCli(['orient'], io())

    expect(code).toBe(0)
    expect(stdout.join('')).toContain('Workspace context: demo')
    expect(existsSync(join(dir, '.mim', 'agent-context.md'))).toBe(true)
  })

  it('appends and reads log entries', async () => {
    await runCli(['init', '--name', 'demo'], io())

    expect(await runCli(['log', 'Finished', 'review'], io())).toBe(0)
    stdout = []
    expect(await runCli(['log', '--read'], io())).toBe(0)

    expect(stdout.join('')).toContain('[user] Finished review')
  })

  it('runs a generic tool with JSON params', async () => {
    await runCli(['init', '--name', 'demo'], io())
    stdout = []

    const code = await runCli(['tool', 'workspace.info', '{}', '--json'], io())

    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.join(''))
    expect(parsed.name).toBe('demo')
  })

  it('runs generic tool calls as the AI actor', async () => {
    await runCli(['init', '--name', 'demo'], io())
    stdout = []

    const code = await runCli(['tool', 'workspace.info', '{}', '--json'], io())

    expect(code).toBe(0)
    const tracesDir = join(dir, '.mim', 'traces')
    const lines = readdirSync(tracesDir).filter(f => f.endsWith('.jsonl')).sort()
      .flatMap(f => readFileSync(join(tracesDir, f), 'utf-8').trim().split('\n').map(line => JSON.parse(line)))
    expect(lines).toContainEqual(expect.objectContaining({
      actor: 'ai',
      kind: 'tool.call',
      tool: 'workspace.info',
    }))
  })

  it('denies high-risk generic tool calls by default in non-interactive mode', async () => {
    await runCli(['init', '--name', 'demo'], io())
    writeFileSync(join(dir, 'victim.txt'), 'delete me')
    stdout = []

    const code = await runCli(['tool', 'fs.delete', '{"path":"victim.txt"}'], io())

    expect(code).toBe(1)
    expect(existsSync(join(dir, 'victim.txt'))).toBe(true)
    expect(stderr.join('')).toContain('Permission denied')
  })

  it('allows high-risk generic tool calls with --yes', async () => {
    await runCli(['init', '--name', 'demo'], io())
    writeFileSync(join(dir, 'victim.txt'), 'delete me')
    stdout = []

    const code = await runCli(['tool', 'fs.delete', '{"path":"victim.txt"}', '--yes'], io())

    expect(code).toBe(0)
    expect(existsSync(join(dir, 'victim.txt'))).toBe(false)
  })

  it('prompts for high-risk generic tool calls on a TTY', async () => {
    await runCli(['init', '--name', 'demo'], io())
    writeFileSync(join(dir, 'victim.txt'), 'delete me')
    const prompts: string[] = []
    stdout = []

    const code = await runCli(['tool', 'fs.delete', '{"path":"victim.txt"}'], io(dir, undefined, {
      isTTY: true,
      confirmApproval: async (request) => {
        prompts.push(request.toolName)
        return true
      },
    }))

    expect(code).toBe(0)
    expect(prompts).toEqual(['fs.delete'])
    expect(existsSync(join(dir, 'victim.txt'))).toBe(false)
  })

  it('runs a generic tool with JSON params from stdin', async () => {
    await runCli(['init', '--name', 'demo'], io())
    stdout = []

    const code = await runCli(['tool', 'workspace.info', '--stdin', '--json'], io(dir, '{}\n'))

    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.join(''))
    expect(parsed.name).toBe('demo')
  })

  it('starts the MCP stdio bridge without opening a headless workspace', async () => {
    const code = await runCli(['mcp'], io(dir, undefined, {
      runMcp: async () => 7,
    }))

    expect(code).toBe(7)
    expect(stderr.join('')).toBe('')
  })

  it('runs an always-on client until the process shutdown signal', async () => {
    writeFileSync(join(dir, 'mim.yaml'), 'name: always-on\n')

    const code = await runCli(
      ['always-on', '--host', '127.0.0.1', '--port', '0'],
      io(dir, undefined, { waitForShutdown: async () => {} }),
    )

    expect(code).toBe(0)
    expect(stdout.join('')).toContain('Always-on client running')
    expect(stdout.join('')).toContain('127.0.0.1:')
  })

  it('runs mim go commands through the shell on Windows so .cmd shims resolve', async () => {
    await runCli(['init', '--name', 'demo'], io())
    const child = {
      on(event: string, cb: (code?: number) => void) {
        if (event === 'exit') cb(0)
        return child
      },
    }
    const spawnCalls: unknown[][] = []

    const code = await runCli(['go', '--', 'codex', '--help'], io(dir, undefined, {
      platform: 'win32',
      spawn: ((...args: unknown[]) => {
        spawnCalls.push(args)
        return child
      }) as typeof spawn,
    }))

    expect(code).toBe(0)
    expect(spawnCalls.at(-1)?.[0]).toBe('codex')
    expect(spawnCalls.at(-1)?.[2]).toMatchObject({ cwd: dir, stdio: 'inherit', shell: true })
  })

  it('reports command errors on stderr', async () => {
    const code = await runCli(['tool'], io())

    expect(code).toBe(1)
    expect(stderr.join('')).toContain('Usage: mim tool')
  })
})
