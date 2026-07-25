import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reset as resetUserConfig, setTeamConnection } from '@main/userConfig.js'
import {
  createTeamSource,
  repositoryUsesGitLfs,
  resolveTeamCheckout,
  teamCheckoutPath,
} from '@main/team/teamSource.js'
import { buildTeamReleaseIndex } from '@main/team/teamReleaseContents.js'

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function seedRemote(root: string, options: { lfs?: boolean } = {}): string {
  const source = join(root, 'source')
  const remote = join(root, 'team.git')
  mkdirSync(source)
  git(['init', '--initial-branch=main'], source)
  git(['config', 'user.name', 'Mim Team Test'], source)
  git(['config', 'user.email', 'team-test@example.com'], source)
  writeFileSync(join(source, 'team.yaml'), 'name: Shoulders\n')
  writeFileSync(join(source, 'instructions.md'), '# Team guidance\n')
  if (options.lfs) {
    writeFileSync(join(source, '.gitattributes'), '*.docx filter=lfs diff=lfs merge=lfs -text\n')
  }
  for (const dir of ['files', 'skills', 'apps', 'routines']) {
    mkdirSync(join(source, dir))
    writeFileSync(join(source, dir, '.gitkeep'), '')
  }
  writeTeamIndex(source)
  git(['add', '-A'], source)
  git(['commit', '-m', 'Seed Team'], source)
  git(['init', '--bare', '--initial-branch=main', remote])
  git(['remote', 'add', 'origin', remote], source)
  git(['push', '-u', 'origin', 'main'], source)
  return remote
}

function writeTeamIndex(root: string): void {
  const index = buildTeamReleaseIndex(root, 'Shoulders')
  writeFileSync(join(root, 'team-index.json'), `${JSON.stringify(index, null, 2)}\n`)
}

function configureIdentity(checkout: string): void {
  git(['config', 'user.name', 'Mim Team Test'], checkout)
  git(['config', 'user.email', 'team-test@example.com'], checkout)
}

describe('Team source contract', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mim-team-contract-'))
    resetUserConfig()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    resetUserConfig()
  })

  it('requires a named team.yaml and treats every other contribution as optional', () => {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout)
    writeFileSync(join(checkout, 'team.yaml'), 'name: Shoulders\n')
    writeTeamIndex(checkout)

    expect(resolveTeamCheckout(checkout)).toEqual({
      name: 'Shoulders',
      root: checkout,
      manifestPath: join(checkout, 'team.yaml'),
      indexPath: join(checkout, 'team-index.json'),
      instructionsPath: null,
      filesPath: join(checkout, 'files'),
      skillsPath: join(checkout, 'skills'),
      appsPath: join(checkout, 'apps'),
      routinesPath: join(checkout, 'routines'),
      contributions: {
        instructions: false,
        files: 0,
        skills: 0,
        apps: 0,
        routines: 0,
      },
    })
  })

  it('validates contribution kinds and counts their immediate entries', () => {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout)
    writeFileSync(join(checkout, 'team.yaml'), 'name: Shoulders\n')
    writeTeamIndex(checkout)
    writeFileSync(join(checkout, 'instructions.md'), '# Shared instructions\n')
    for (const dir of ['files', 'skills', 'apps', 'routines']) mkdirSync(join(checkout, dir))
    writeFileSync(join(checkout, 'files', 'template.md'), 'Template')
    mkdirSync(join(checkout, 'skills', 'review'))
    mkdirSync(join(checkout, 'apps', 'tracker'))
    mkdirSync(join(checkout, 'routines', 'daily'))

    const resolved = resolveTeamCheckout(checkout)
    expect(resolved.instructionsPath).toBe(join(checkout, 'instructions.md'))
    expect(resolved.contributions).toEqual({
      instructions: true,
      files: 1,
      skills: 1,
      apps: 1,
      routines: 1,
    })

    rmSync(join(checkout, 'skills'), { recursive: true })
    writeFileSync(join(checkout, 'skills'), 'not a directory')
    expect(() => resolveTeamCheckout(checkout)).toThrow('skills/ must be a directory')
  })

  it('rejects missing, malformed, and unnamed manifests', () => {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout)
    expect(() => resolveTeamCheckout(checkout)).toThrow('team.yaml')

    writeFileSync(join(checkout, 'team.yaml'), 'name: [broken')
    expect(() => resolveTeamCheckout(checkout)).toThrow('valid YAML')

    writeFileSync(join(checkout, 'team.yaml'), 'name: "   "\n')
    expect(() => resolveTeamCheckout(checkout)).toThrow('non-empty name')

    writeFileSync(join(checkout, 'team.yaml'), 'name: Shoulders\n')
    expect(() => resolveTeamCheckout(checkout)).toThrow('team-index.json')
  })

  it('detects Git LFS only when repository attributes request its filter', () => {
    const checkout = join(root, 'checkout')
    mkdirSync(join(checkout, 'files'), { recursive: true })
    expect(repositoryUsesGitLfs(checkout)).toBe(false)

    writeFileSync(join(checkout, '.gitattributes'), '*.pdf binary\n')
    writeFileSync(join(checkout, 'files', '.gitattributes'), '*.docx filter=lfs diff=lfs merge=lfs -text\n')
    expect(repositoryUsesGitLfs(checkout)).toBe(true)
  })
})

describe('Team connection and updates', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mim-team-source-'))
    resetUserConfig()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    resetUserConfig()
  })

  it('reports a disconnected installation without creating Personal state', async () => {
    const home = join(root, 'home')
    mkdirSync(home)
    const source = createTeamSource({ homeDir: home })

    await expect(source.status()).resolves.toMatchObject({
      state: 'disconnected',
      repository: null,
      root: teamCheckoutPath(home),
      git: { available: true },
    })
    expect(existsSync(join(home, '.mim', 'config.yaml'))).toBe(false)
  })

  it('clones, validates, and persists exactly one credential-free Team connection', async () => {
    const remote = seedRemote(root)
    const home = join(root, 'home')
    mkdirSync(home)
    const source = createTeamSource({ homeDir: home })

    const connected = await source.connect(remote)

    expect(connected).toMatchObject({
      state: 'synced',
      repository: remote,
      team: { name: 'Shoulders' },
      dirty: false,
      ahead: 0,
      behind: 0,
      update: { state: 'current', changes: [] },
    })
    expect(connected.root).toBe(teamCheckoutPath(home))
    expect(readFileSync(join(home, '.mim', 'config.yaml'), 'utf-8')).toContain(`repository: ${remote}`)
    expect(await source.open()).toMatchObject({ name: 'Shoulders', root: teamCheckoutPath(home) })
    await expect(source.connect(remote)).rejects.toThrow('already connected')
  })

  it('does not persist or retain a clone when the Team contract is invalid', async () => {
    const sourceDir = join(root, 'invalid-source')
    const remote = join(root, 'invalid.git')
    mkdirSync(sourceDir)
    git(['init', '--initial-branch=main'], sourceDir)
    git(['config', 'user.name', 'Mim Team Test'], sourceDir)
    git(['config', 'user.email', 'team-test@example.com'], sourceDir)
    writeFileSync(join(sourceDir, 'README.md'), 'No Team manifest')
    git(['add', '-A'], sourceDir)
    git(['commit', '-m', 'Invalid Team'], sourceDir)
    git(['init', '--bare', '--initial-branch=main', remote])
    git(['remote', 'add', 'origin', remote], sourceDir)
    git(['push', '-u', 'origin', 'main'], sourceDir)

    const home = join(root, 'home')
    mkdirSync(home)
    const source = createTeamSource({ homeDir: home })

    await expect(source.connect(remote)).rejects.toThrow('team.yaml')
    expect(existsSync(teamCheckoutPath(home))).toBe(false)
    expect(existsSync(join(home, '.mim', 'config.yaml'))).toBe(false)
  })

  it('upgrades a connected Team checkout created before release indexes', async () => {
    const sourceDir = join(root, 'legacy-source')
    const remote = join(root, 'legacy.git')
    const home = join(root, 'home')
    const checkout = teamCheckoutPath(home)
    mkdirSync(sourceDir)
    mkdirSync(home)
    git(['init', '--initial-branch=main'], sourceDir)
    git(['config', 'user.name', 'Mim Team Test'], sourceDir)
    git(['config', 'user.email', 'team-test@example.com'], sourceDir)
    writeFileSync(join(sourceDir, 'team.yaml'), 'name: Shoulders\n')
    writeFileSync(join(sourceDir, 'instructions.md'), '# Existing guidance\n')
    for (const dir of ['files', 'skills', 'apps', 'routines']) {
      mkdirSync(join(sourceDir, dir))
      writeFileSync(join(sourceDir, dir, '.gitkeep'), '')
    }
    git(['add', '-A'], sourceDir)
    git(['commit', '-m', 'Legacy Team'], sourceDir)
    git(['init', '--bare', '--initial-branch=main', remote])
    git(['remote', 'add', 'origin', remote], sourceDir)
    git(['push', '-u', 'origin', 'main'], sourceDir)
    mkdirSync(join(home, '.mim'))
    git(['clone', remote, checkout])
    setTeamConnection({ repository: remote }, home)

    writeTeamIndex(sourceDir)
    git(['add', 'team-index.json'], sourceDir)
    git(['commit', '-m', 'Publish first indexed release'], sourceDir)
    git(['push'], sourceDir)

    const client = createTeamSource({ homeDir: home })
    await expect(client.status()).resolves.toMatchObject({
      state: 'synced',
      team: { name: 'Shoulders' },
      update: { state: 'unknown' },
    })
    await expect(client.check()).resolves.toMatchObject({
      update: {
        state: 'available',
        changes: [{ kind: 'instructions', action: 'added' }],
      },
    })

    const updated = await client.update()
    expect(existsSync(join(checkout, 'team-index.json'))).toBe(true)
    expect(updated).toMatchObject({
      state: 'synced',
      update: {
        state: 'current',
        recentChanges: [{ kind: 'instructions', action: 'added' }],
      },
    })
  })

  it('publishes local Team edits and applies remote Team updates only when requested', async () => {
    const remote = seedRemote(root)
    const homeA = join(root, 'home-a')
    const homeB = join(root, 'home-b')
    mkdirSync(homeA)
    mkdirSync(homeB)
    const clientA = createTeamSource({ homeDir: homeA })
    const clientB = createTeamSource({ homeDir: homeB })
    await clientA.connect(remote)
    await clientB.connect(remote)
    configureIdentity(teamCheckoutPath(homeA))
    configureIdentity(teamCheckoutPath(homeB))

    writeFileSync(join(teamCheckoutPath(homeA), 'files', 'brief.md'), 'Version A\n')
    writeTeamIndex(teamCheckoutPath(homeA))
    await expect(clientA.status()).resolves.toMatchObject({ state: 'needs-sync', dirty: true })
    await expect(clientA.publish()).resolves.toMatchObject({ dirty: false })

    await expect(clientB.check()).resolves.toMatchObject({
      update: {
        state: 'available',
        changes: [{ kind: 'file', id: 'brief.md', action: 'added' }],
      },
    })
    expect(existsSync(join(teamCheckoutPath(homeB), 'files', 'brief.md'))).toBe(false)
    await clientB.update()
    expect(readFileSync(join(teamCheckoutPath(homeB), 'files', 'brief.md'), 'utf-8')).toBe('Version A\n')

    writeFileSync(join(teamCheckoutPath(homeB), 'files', 'brief.md'), 'Version B\n')
    writeTeamIndex(teamCheckoutPath(homeB))
    await clientB.publish()
    await clientA.check()
    await clientA.update()
    expect(readFileSync(join(teamCheckoutPath(homeA), 'files', 'brief.md'), 'utf-8')).toBe('Version B\n')
  })

  it('discovers an app update without changing installed code, then records the applied change', async () => {
    const remote = seedRemote(root)
    const home = join(root, 'home')
    mkdirSync(home)
    const client = createTeamSource({ homeDir: home })
    await client.connect(remote)
    configureIdentity(teamCheckoutPath(home))

    const source = join(root, 'source')
    mkdirSync(join(source, 'apps', 'knowledge'), { recursive: true })
    writeFileSync(join(source, 'apps', 'knowledge', 'package.json'), JSON.stringify({
      name: '@test/knowledge',
      version: '1.0.0',
      mim: { manifestVersion: 1, id: 'knowledge', name: 'Knowledge', views: [], permissions: {} },
    }))
    writeTeamIndex(source)
    git(['add', '-A'], source)
    git(['commit', '-m', 'Publish Knowledge'], source)
    git(['push'], source)

    const available = await client.check()
    expect(available.update).toMatchObject({
      state: 'available',
      changes: [{
        kind: 'app',
        id: 'knowledge',
        name: 'Knowledge',
        action: 'added',
        nextVersion: '1.0.0',
      }],
    })
    expect(existsSync(join(teamCheckoutPath(home), 'apps', 'knowledge'))).toBe(false)

    const updated = await client.update()
    expect(existsSync(join(teamCheckoutPath(home), 'apps', 'knowledge', 'package.json'))).toBe(true)
    expect(updated.update).toMatchObject({
      state: 'current',
      changes: [],
      recentChanges: [{ kind: 'app', id: 'knowledge', action: 'added' }],
    })
  })

  it('refuses a remote release whose index does not match its app content', async () => {
    const remote = seedRemote(root)
    const home = join(root, 'home')
    mkdirSync(home)
    const client = createTeamSource({ homeDir: home })
    await client.connect(remote)
    configureIdentity(teamCheckoutPath(home))

    const source = join(root, 'source')
    mkdirSync(join(source, 'apps', 'knowledge'), { recursive: true })
    writeFileSync(join(source, 'apps', 'knowledge', 'package.json'), JSON.stringify({
      name: '@test/knowledge',
      version: '1.0.0',
      mim: { manifestVersion: 1, id: 'knowledge', name: 'Knowledge', views: [], permissions: {} },
    }))
    writeTeamIndex(source)
    const indexPath = join(source, 'team-index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf-8'))
    index.apps[0].digest = 'f'.repeat(64)
    writeFileSync(indexPath, JSON.stringify(index, null, 2))
    git(['add', '-A'], source)
    git(['commit', '-m', 'Publish invalid Knowledge release'], source)
    git(['push'], source)

    await expect(client.check()).resolves.toMatchObject({
      update: { state: 'available' },
    })
    await expect(client.update()).resolves.toMatchObject({
      state: 'stopped',
      message: expect.stringContaining('does not match'),
    })
    expect(existsSync(join(teamCheckoutPath(home), 'apps', 'knowledge'))).toBe(false)
  })

  it('preserves both Team versions when two clients edit the same file', async () => {
    const remote = seedRemote(root)
    const homeA = join(root, 'home-a')
    const homeB = join(root, 'home-b')
    mkdirSync(homeA)
    mkdirSync(homeB)
    const clientA = createTeamSource({ homeDir: homeA })
    const clientB = createTeamSource({ homeDir: homeB })
    await clientA.connect(remote)
    await clientB.connect(remote)
    configureIdentity(teamCheckoutPath(homeA))
    configureIdentity(teamCheckoutPath(homeB))

    const pathA = join(teamCheckoutPath(homeA), 'files', 'brief.md')
    const pathB = join(teamCheckoutPath(homeB), 'files', 'brief.md')
    writeFileSync(pathA, 'baseline\n')
    writeTeamIndex(teamCheckoutPath(homeA))
    await clientA.publish()
    await clientB.check()
    await clientB.update()

    writeFileSync(pathA, 'client A\n')
    writeFileSync(pathB, 'client B\n')
    writeTeamIndex(teamCheckoutPath(homeA))
    writeTeamIndex(teamCheckoutPath(homeB))
    await clientA.publish()
    await clientB.check()
    const stopped = await clientB.update()

    expect(stopped).toMatchObject({ state: 'stopped', retryable: false })
    expect(stopped.message).toContain('preserved')
    const copies = readdirSync(join(teamCheckoutPath(homeB), 'files'))
      .filter(name => name.startsWith('brief.conflict-'))
    expect(copies).toHaveLength(2)
    expect(copies.map(name => readFileSync(join(teamCheckoutPath(homeB), 'files', name), 'utf-8')).sort())
      .toEqual(['client A\n', 'client B\n'])
    expect(readFileSync(pathB, 'utf-8')).toBe('client B\n')
  }, 15_000)

  it('rejects HTTP repositories and credential-bearing URLs before invoking Git', async () => {
    const home = join(root, 'home')
    mkdirSync(home)
    const source = createTeamSource({ homeDir: home })

    await expect(source.connect('http://example.com/team.git')).rejects.toThrow('HTTPS')
    await expect(source.connect('https://user:secret@example.com/team.git')).rejects.toThrow('credentials')
    expect(existsSync(teamCheckoutPath(home))).toBe(false)
  })

  it('requires Git LFS only when the connected repository attributes use it', async () => {
    const remote = seedRemote(root, { lfs: true })
    const home = join(root, 'home')
    mkdirSync(home)
    const source = createTeamSource({
      homeDir: home,
      platform: 'darwin',
      hasGitLfs: async () => false,
    })

    await expect(source.connect(remote)).rejects.toThrow('brew install git-lfs')
    expect(existsSync(teamCheckoutPath(home))).toBe(false)
    expect(existsSync(join(home, '.mim', 'config.yaml'))).toBe(false)
  })
})
