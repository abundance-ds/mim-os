import { describe, expect, it, vi } from 'vitest'
import type { HeadlessKernel } from '@main/headless.js'
import type { LoadedPackage, PackageLoader } from '@main/packages/packages.js'
import { runPackageTui } from './packageTui.js'

function knowledgePackage(overrides: Partial<LoadedPackage> = {}): LoadedPackage {
  return {
    dir: '/team/apps/knowledge',
    source: 'team',
    hasReadme: true,
    manifest: {
      manifestVersion: 1,
      id: 'knowledge',
      name: 'Knowledge',
      version: '0.4.0',
      views: [],
      tui: { entry: './tui/index.mjs' },
      permissions: {},
    },
    ...overrides,
  }
}

function kernelFor(pkg: LoadedPackage | undefined, enabled = true) {
  const calls: unknown[][] = []
  const packages = {
    get: vi.fn(() => pkg),
  } as unknown as PackageLoader
  const tools = {
    call: vi.fn(async (name: string, params: unknown, context: unknown) => {
      calls.push([name, params, context])
      if (name === 'app.status') {
        return { apps: pkg ? [{ id: pkg.manifest.id, enabled }] : [] }
      }
      return { name, params }
    }),
  }
  return {
    calls,
    kernel: {
      getPackages: () => packages,
      tools,
    } as unknown as HeadlessKernel,
  }
}

describe('package TUI host', () => {
  it('loads the enabled package entry and attributes its tool calls to the app identity', async () => {
    const pkg = knowledgePackage()
    const { kernel, calls } = kernelFor(pkg)
    const terminal = { columns: 120, rows: 36 }
    const toolkit = { TUI: class {} }
    const run = vi.fn(async context => {
      expect(context.package).toMatchObject({ id: 'knowledge', name: 'Knowledge', source: 'team' })
      expect(context.terminal).toBe(terminal)
      expect(context.toolkit).toBe(toolkit)
      await context.call('knowledge.list', { limit: 50 })
      return 7
    })

    const code = await runPackageTui(kernel, 'knowledge', {
      terminal,
      toolkit,
      importModule: async path => {
        expect(path).toContain('/team/apps/knowledge/tui/index.mjs')
        return { run }
      },
    })

    expect(code).toBe(7)
    expect(run).toHaveBeenCalledOnce()
    expect(calls).toContainEqual([
      'knowledge.list',
      { limit: 50 },
      { actor: 'package', package_id: 'knowledge', sessionId: 'tui:knowledge' },
    ])
  })

  it('requires the app to be available, enabled, and TUI-capable', async () => {
    await expect(runPackageTui(kernelFor(undefined).kernel, 'missing', {
      terminal: {},
      toolkit: {},
    })).rejects.toThrow('App is not available: missing')

    await expect(runPackageTui(kernelFor(knowledgePackage(), false).kernel, 'knowledge', {
      terminal: {},
      toolkit: {},
    })).rejects.toThrow('Enable "Knowledge"')

    const withoutTui = knowledgePackage({
      manifest: { ...knowledgePackage().manifest, tui: undefined },
    })
    await expect(runPackageTui(kernelFor(withoutTui).kernel, 'knowledge', {
      terminal: {},
      toolkit: {},
    })).rejects.toThrow('does not provide a terminal interface')
  })

  it('rejects a terminal module without a run function', async () => {
    await expect(runPackageTui(kernelFor(knowledgePackage()).kernel, 'knowledge', {
      terminal: {},
      toolkit: {},
      importModule: async () => ({}),
    })).rejects.toThrow('must export run(context)')
  })
})
