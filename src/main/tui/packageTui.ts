import { pathToFileURL } from 'url'
import type { HeadlessKernel } from '@main/headless.js'
import { resolveInsidePackage } from '@main/packages/packageManifest.js'

export interface PackageTuiContext {
  package: {
    id: string
    name: string
    version: string
    source: 'mim' | 'team' | 'project'
  }
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  toolkit: Record<string, unknown>
  terminal: unknown
}

interface PackageTuiModule {
  run?: (context: PackageTuiContext) => Promise<number | void> | number | void
}

interface PackageTuiHostOptions {
  terminal?: unknown
  toolkit?: Record<string, unknown>
  importModule?: (path: string) => Promise<PackageTuiModule>
}

export async function runPackageTui(
  kernel: HeadlessKernel,
  packageId: string,
  options: PackageTuiHostOptions = {},
): Promise<number> {
  const pkg = kernel.getPackages().get(packageId)
  if (!pkg) throw new Error(`App is not available: ${packageId}`)
  if (!pkg.manifest.tui) {
    throw new Error(`"${pkg.manifest.name}" does not provide a terminal interface`)
  }

  const status = await kernel.tools.call('app.status', {}, {
    actor: 'user',
    sessionId: `tui:${packageId}`,
  }) as { apps?: Array<{ id?: string; enabled?: boolean }> }
  const enabled = status.apps?.find(app => app.id === packageId)?.enabled === true
  if (!enabled) {
    throw new Error(`Enable "${pkg.manifest.name}" in Settings > Apps & agents before opening its terminal interface`)
  }

  const entryPath = resolveInsidePackage(pkg.dir, pkg.manifest.tui.entry)
  if (!entryPath) throw new Error(`Invalid terminal interface entry for "${pkg.manifest.name}"`)

  const toolkit = options.toolkit ?? await import('@mariozechner/pi-tui') as Record<string, unknown>
  const ProcessTerminal = toolkit.ProcessTerminal as (new () => unknown) | undefined
  const terminal = options.terminal ?? (ProcessTerminal ? new ProcessTerminal() : null)
  if (!terminal) throw new Error('The terminal interface runtime is unavailable')

  const importModule = options.importModule ?? (async path =>
    import(`${pathToFileURL(path).href}?mim-tui=${Date.now()}`) as Promise<PackageTuiModule>)
  const mod = await importModule(entryPath)
  if (typeof mod.run !== 'function') {
    throw new Error(`Terminal interface for "${pkg.manifest.name}" must export run(context)`)
  }

  const result = await mod.run({
    package: {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      source: pkg.source,
    },
    call: (name, params = {}) => kernel.tools.call(name, params, {
      actor: 'package',
      package_id: packageId,
      sessionId: `tui:${packageId}`,
    }),
    toolkit,
    terminal,
  })
  return Number.isInteger(result) ? Number(result) : 0
}
