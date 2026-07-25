import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createPackageLoader } from './packages.js'
import { createToolRegistry } from '@main/tools/registry.js'
import { createTraceLog } from '@main/trace/trace.js'

let loaders: Array<Awaited<ReturnType<typeof createPackageLoader>>> = []

afterEach(async () => {
  await Promise.all(loaders.map(loader => loader.close?.()))
  loaders = []
})

function writeApp(root: string, id: string, name: string, version = '1.0.0'): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@mim/${id}`,
    version,
    type: 'module',
    mim: {
      manifestVersion: 1,
      id,
      name,
      views: [],
      permissions: {},
      engines: { mim: 'runtime-v1' },
    },
  }))
}

describe('direct app sources', () => {
  let temp: string
  let project: string
  let team: string
  let mim: string
  let tools: ReturnType<typeof createToolRegistry>

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'mim-app-sources-'))
    project = join(temp, 'project')
    team = join(temp, 'team-apps')
    mim = join(temp, 'mim-built-ins')
    mkdirSync(join(project, 'packages'), { recursive: true })
    mkdirSync(team, { recursive: true })
    mkdirSync(mim, { recursive: true })
    tools = createToolRegistry(createTraceLog())
    tools.setWorkspacePath(project)
  })

  afterEach(() => {
    rmSync(temp, { recursive: true, force: true })
  })

  async function load() {
    const loader = await createPackageLoader(tools, { teamDir: team, mimDir: mim })
    loaders.push(loader)
    return loader
  }

  it('discovers Mim, Team, and Project apps directly from their natural roots', async () => {
    writeApp(mim, 'built-in', 'Built in')
    writeApp(team, 'shared', 'Shared')
    writeApp(join(project, 'packages'), 'local', 'Local')

    const loader = await load()

    expect(loader.get('built-in')?.source).toBe('mim')
    expect(loader.get('shared')?.source).toBe('team')
    expect(loader.get('local')?.source).toBe('project')
  })

  it('resolves Project over Team over Mim and reports the shadowed origins', async () => {
    writeApp(mim, 'same', 'Mim')
    writeApp(team, 'same', 'Team')
    writeApp(join(project, 'packages'), 'same', 'Project')

    const loader = await load()

    expect(loader.get('same')?.manifest.name).toBe('Project')
    expect(loader.get('same')?.source).toBe('project')
    expect(loader.get('same')?.shadowedSources).toEqual(['mim', 'team'])
  })

  it('keeps a disabled source available and picks it up on rescan', async () => {
    const loader = await load()
    expect(loader.get('later')).toBeUndefined()

    writeApp(team, 'later', 'Later')
    await loader.rescan()

    expect(loader.get('later')?.source).toBe('team')
  })

  it('rejects an app for an incompatible Mim runtime', async () => {
    writeApp(team, 'future', 'Future')
    const manifestPath = join(team, 'future', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    manifest.mim.engines.mim = 'runtime-v999'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const loader = await load()

    expect(loader.get('future')).toBeUndefined()
    expect(loader.diagnostics()[0]?.message).toContain('engine incompatible')
  })
})
