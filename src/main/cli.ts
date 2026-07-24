#!/usr/bin/env node

import { existsSync } from 'fs'
import { basename, dirname, isAbsolute, resolve } from 'path'
import { spawn } from 'child_process'
import { createInterface } from 'readline/promises'
import { fileURLToPath } from 'url'
import { createHeadlessKernel, type HeadlessKernel } from '@main/headless.js'
import type { PermissionApprovalRequest } from '@main/security/gate.js'
import { runMcpStdio } from '@main/mcp/stdio.js'
import { runPackageTui } from '@main/tui/packageTui.js'

export interface CliIO {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  stdin?: () => Promise<string>
  isTTY?: boolean
  confirmApproval?: (request: PermissionApprovalRequest) => Promise<boolean>
  spawn?: typeof spawn
  runMcp?: () => Promise<number>
  runPackageTui?: (kernel: HeadlessKernel, packageId: string) => Promise<number>
  waitForShutdown?: () => Promise<void>
  platform?: NodeJS.Platform
}

interface ParsedArgs {
  command: string
  args: string[]
  workspace?: string
  json: boolean
  yes: boolean
}

const HELP = `mim

Usage:
  mim init [path] [--name name]
  mim status [--workspace path]
  mim orient [--workspace path] [--json]
  mim log <message> [--workspace path]
  mim log --read [--workspace path] [--json]
  mim tool <name> [json|--stdin] [--workspace path] [--json] [--yes]
  mim list-tools [--json]
  mim go [--workspace path] [-- command ...]
  mim always-on [--workspace path] [--host address] [--port number]
  mim tui <app> [--workspace path]
  mim k [--workspace path]              # Knowledge TUI
  mim mcp
`

export async function runCli(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  let kernel: HeadlessKernel | null = null
  try {
    const parsed = parseArgs(argv)

    if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
      io.stdout(HELP)
      return 0
    }

    if (parsed.command === 'list-tools') {
      kernel = createHeadlessKernel(headlessOptions(parsed, io))
      const tools = kernel.tools.list().map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
      writeResult(io, parsed, { tools })
      return 0
    }

    if (parsed.command === 'mcp') {
      if (parsed.args.length > 0) throw new Error('Usage: mim mcp')
      return io.runMcp ? io.runMcp() : runMcpStdio()
    }

    if (parsed.command === 'always-on') {
      const runtime = parseAlwaysOnArgs(parsed.args)
      kernel = await openKernelForWorkspace(parsed, io)
      const status = await kernel.startAlwaysOn(runtime)
      if (parsed.json) writeResult(io, parsed, status)
      else io.stdout(`Always-on client running for ${kernel.tools.getWorkspacePath()} at http://${status.host}:${status.port}\n`)
      await (io.waitForShutdown?.() ?? waitForShutdownSignal())
      return 0
    }

    if (parsed.command === 'tui' || parsed.command === 'k') {
      if (io.isTTY === false) throw new Error('Package terminal interfaces require an interactive terminal')
      const packageId = parsed.command === 'k' ? 'knowledge' : parsed.args[0]
      if (!packageId || (parsed.command === 'tui' && parsed.args.length !== 1)) {
        throw new Error('Usage: mim tui <app>')
      }
      if (parsed.command === 'k' && parsed.args.length > 0) {
        throw new Error('Usage: mim k [--workspace path]')
      }
      kernel = await openKernelForWorkspace(parsed, io)
      return io.runPackageTui
        ? io.runPackageTui(kernel, packageId)
        : runPackageTui(kernel, packageId)
    }

    if (parsed.command === 'init') {
      const { path, name } = parseInitArgs(parsed.args, io.cwd, parsed.workspace)
      kernel = createHeadlessKernel(headlessOptions(parsed, io))
      await kernel.openWorkspace(path)
      const result = await kernel.tools.call('workspace.init', { name: name ?? basename(path) }, { actor: 'user' })
      writeResult(io, parsed, result)
      return 0
    }

    if (parsed.command === 'status') {
      kernel = await openKernelForWorkspace(parsed, io)
      const status = await kernel.tools.call('workspace.status', {}, { actor: 'user' })
      const info = await kernel.tools.call('workspace.info', {}, { actor: 'user' })
      writeResult(io, parsed, { status, info })
      return 0
    }

    if (parsed.command === 'orient') {
      kernel = await openKernelForWorkspace(parsed, io)
      const result = await kernel.tools.call('workspace.orient', {}, { actor: 'user' }) as { content?: string }
      if (parsed.json) writeResult(io, parsed, result)
      else io.stdout(result.content ?? '')
      return 0
    }

    if (parsed.command === 'log') {
      kernel = await openKernelForWorkspace(parsed, io)
      if (parsed.args[0] === '--read') {
        const result = await kernel.tools.call('log.read', {}, { actor: 'user' }) as { content?: string }
        if (parsed.json) writeResult(io, parsed, result)
        else io.stdout(result.content ?? '')
        return 0
      }
      const message = parsed.args.join(' ').trim()
      if (!message) throw new Error('Usage: mim log <message>')
      const result = await kernel.tools.call('log.append', { message }, { actor: 'user' })
      writeResult(io, parsed, result)
      return 0
    }

    if (parsed.command === 'tool') {
      const { name, rawJson, useStdin } = parseToolArgs(parsed.args)
      if (!name) throw new Error('Usage: mim tool <name> [json]')
      const params = rawJson || useStdin ? parseJson(rawJson ?? await readStdin(io)) : {}
      kernel = await openKernelForWorkspace(parsed, io)
      const result = await kernel.tools.call(name, params, { actor: 'ai', sessionId: 'cli' })
      writeResult(io, parsed, result)
      return 0
    }

    if (parsed.command === 'go') {
      const separator = parsed.args.indexOf('--')
      const command = separator >= 0 ? parsed.args.slice(separator + 1) : parsed.args
      const external = command.length > 0 ? command : ['claude']
      kernel = await openKernelForWorkspace(parsed, io)
      await kernel.tools.call('workspace.orient', {}, { actor: 'user' })
      return runExternal(external, kernel.tools.getWorkspacePath() ?? io.cwd, io)
    }

    io.stderr(HELP)
    return 1
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`)
    return 1
  } finally {
    try {
      await kernel?.shutdown()
    } catch {
      // Shutdown is best-effort; the command result has already been decided.
    }
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv]
  let workspace: string | undefined
  let json = false
  let yes = false

  for (let i = 0; i < args.length;) {
    const arg = args[i]
    if (arg === '--') break
    if (arg === '--workspace' || arg === '-w') {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for ${arg}`)
      }
      workspace = value
      args.splice(i, 2)
      continue
    }
    if (arg === '--json') {
      json = true
      args.splice(i, 1)
      continue
    }
    if (arg === '--yes') {
      yes = true
      args.splice(i, 1)
      continue
    }
    i++
  }

  return {
    command: args[0] ?? 'help',
    args: args.slice(1),
    workspace,
    json,
    yes,
  }
}

export function findWorkspaceRoot(start: string): string | null {
  let current = resolve(start)
  while (true) {
    if (existsSync(resolve(current, 'mim.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function openKernelForWorkspace(parsed: ParsedArgs, io: CliIO) {
  const path = resolveWorkspacePath(parsed.workspace, io.cwd)
  const kernel = createHeadlessKernel(headlessOptions(parsed, io))
  await kernel.openWorkspace(path)
  return kernel
}

function resolveWorkspacePath(workspace: string | undefined, cwd: string): string {
  if (workspace) return resolvePath(cwd, workspace)
  return findWorkspaceRoot(cwd) ?? cwd
}

function parseInitArgs(args: string[], cwd: string, workspace?: string): { path: string; name?: string } {
  let name: string | undefined
  const rest = [...args]
  for (let i = 0; i < rest.length;) {
    if (rest[i] === '--name') {
      name = rest[i + 1]
      rest.splice(i, 2)
      continue
    }
    i++
  }
  return {
    path: resolvePath(cwd, workspace ?? rest[0] ?? cwd),
    name,
  }
}

function parseToolArgs(args: string[]): { name?: string; rawJson?: string; useStdin: boolean } {
  const [name, ...rest] = args
  const useStdin = rest.includes('--stdin')
  const jsonArgs = rest.filter(arg => arg !== '--stdin')
  if (useStdin && jsonArgs.length > 0) {
    throw new Error('Usage: mim tool <name> [json|--stdin]')
  }
  if (jsonArgs.length > 1) {
    throw new Error('Usage: mim tool <name> [json|--stdin]')
  }
  return { name, rawJson: jsonArgs[0], useStdin }
}

function parseAlwaysOnArgs(args: string[]): { host?: string; port?: number } {
  const result: { host?: string; port?: number } = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!value) throw new Error('Usage: mim always-on [--host address] [--port number]')
    if (flag === '--host') {
      if (/[\r\n\0]/.test(value)) throw new Error('Invalid always-on host')
      result.host = value
      continue
    }
    if (flag === '--port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Always-on port must be 0-65535')
      result.port = port
      continue
    }
    throw new Error(`Unknown always-on option: ${flag}`)
  }
  return result
}

function resolvePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function parseJson(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool params must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function writeResult(io: CliIO, parsed: ParsedArgs, value: unknown): void {
  if (parsed.json) {
    io.stdout(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (typeof value === 'string') {
    io.stdout(`${value}\n`)
    return
  }
  io.stdout(`${JSON.stringify(value, null, 2)}\n`)
}

function headlessOptions(parsed: ParsedArgs, io: CliIO) {
  return {
    approvals: parsed.yes ? 'allow' as const : io.isTTY ? 'prompt' as const : 'deny' as const,
    confirmApproval: io.confirmApproval ?? defaultConfirmApproval,
  }
}

async function defaultConfirmApproval(request: PermissionApprovalRequest): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const target = request.target ? ` ${request.target}` : ''
    const answer = await rl.question(
      `Approve ${request.risk}-risk ${request.toolName}${target}? Type "yes" to continue: `,
    )
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function readStdin(io: CliIO): Promise<string> {
  if (io.stdin) return io.stdin()
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function runExternal(command: string[], cwd: string, io: CliIO): Promise<number> {
  const spawnImpl = io.spawn ?? spawn
  const platform = io.platform ?? process.platform
  return new Promise<number>((resolveCode) => {
    const child = spawnImpl(command[0], command.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: platform === 'win32',
    })
    child.on('error', (err) => {
      io.stderr(`${err.message}\n`)
      resolveCode(1)
    })
    child.on('exit', (code) => resolveCode(code ?? 0))
  })
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise(resolveSignal => {
    const finish = () => {
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      resolveSignal()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
  })
}

function defaultIO(): CliIO {
  return {
    cwd: process.cwd(),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}
