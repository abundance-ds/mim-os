import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  parsePackageManifest,
  matchesToolGrant,
  applyToolRiskFloor,
  isValidPublicToolName,
} from '@main/packages/packageManifest.js'

describe('package manifest v1', () => {
  function withPackage(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'mim-manifest-test-'))
    mkdirSync(join(dir, 'ui'), { recursive: true })
    writeFileSync(join(dir, 'ui', 'index.html'), '<h1>Package</h1>')
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  function baseManifest() {
    return {
      name: '@mim/test',
      version: '0.1.0',
      mim: {
        manifestVersion: 1,
        id: 'test-package',
        name: 'Test Package',
        views: [{ id: 'main', label: 'Main', src: './ui/index.html', role: 'work' }],
        permissions: { workspace: { read: true } },
      },
    }
  }

  it('accepts a UI package with a static mim block', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest(), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest).toMatchObject({
      id: 'test-package',
      name: 'Test Package',
      version: '0.1.0',
      views: [{ id: 'main', label: 'Main', src: './ui/index.html', role: 'work' }],
    })
  }))

  it('accepts a headless backend package', () => withPackage((dir) => {
    mkdirSync(join(dir, 'backend'), { recursive: true })
    writeFileSync(join(dir, 'backend', 'index.mjs'), 'export const tools = {}')
    const pkg = baseManifest()
    pkg.mim.views = []
    ;(pkg.mim as Record<string, unknown>).backend = './backend/index.mjs'

    const result = parsePackageManifest(pkg, dir)

    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.views).toEqual([])
    expect(result.manifest?.backend).toBe('./backend/index.mjs')
  }))

  it('accepts one package-owned terminal interface inside tui/', () => withPackage((dir) => {
    mkdirSync(join(dir, 'tui'), { recursive: true })
    writeFileSync(join(dir, 'tui', 'index.mjs'), 'export async function run() {}')
    const pkg = baseManifest()
    ;(pkg.mim as Record<string, unknown>).tui = { entry: './tui/index.mjs' }

    const result = parsePackageManifest(pkg, dir)

    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.tui).toEqual({ entry: './tui/index.mjs' })
  }))

  it('rejects terminal interface entries outside tui/', () => withPackage((dir) => {
    writeFileSync(join(dir, 'outside.mjs'), 'export async function run() {}')
    const pkg = baseManifest()
    ;(pkg.mim as Record<string, unknown>).tui = { entry: './outside.mjs' }

    const result = parsePackageManifest(pkg, dir)

    expect(result.manifest).toBeNull()
    expect(result.diagnostics.some(d => d.message.includes('inside tui/'))).toBe(true)
  }))

  it('rejects missing terminal interface entry files', () => withPackage((dir) => {
    const pkg = baseManifest()
    ;(pkg.mim as Record<string, unknown>).tui = { entry: './tui/missing.mjs' }

    const result = parsePackageManifest(pkg, dir)

    expect(result.manifest).toBeNull()
    expect(result.diagnostics.some(d => d.message.includes('TUI entry file does not exist'))).toBe(true)
  }))

  it('rejects missing manifestVersion', () => withPackage((dir) => {
    const pkg = baseManifest()
    delete (pkg.mim as Partial<typeof pkg.mim>).manifestVersion

    const result = parsePackageManifest(pkg, dir)

    expect(result.manifest).toBeNull()
    expect(result.diagnostics[0].message).toContain('manifestVersion')
  }))

  it('rejects view paths outside ui/', () => withPackage((dir) => {
    writeFileSync(join(dir, 'secret.html'), 'no')
    const pkg = baseManifest()
    pkg.mim.views = [{ id: 'main', label: 'Main', src: './secret.html', role: 'work' }]

    const result = parsePackageManifest(pkg, dir)

    expect(result.manifest).toBeNull()
    expect(result.diagnostics.some(d => d.message.includes('inside ui/'))).toBe(true)
  }))

  it('rejects backend paths that escape the package directory', () => withPackage((dir) => {
    const pkg = baseManifest()
    ;(pkg.mim as Record<string, unknown>).backend = '../outside.mjs'

    const result = parsePackageManifest(pkg, dir)

    expect(result.manifest).toBeNull()
    expect(result.diagnostics.some(d => d.message.includes('backend'))).toBe(true)
  }))

  it('rejects views without an explicit Work/Artifact role', () => withPackage((dir) => {
    const pkg = baseManifest()
    pkg.mim.views = [{ id: 'main', label: 'Main', src: './ui/index.html' } as any]

    const result = parsePackageManifest(pkg, dir)

    expect(result.manifest).toBeNull()
    expect(result.diagnostics.some(d => d.message.includes('role'))).toBe(true)
  }))

  it('rejects URL-shaped HTTP permission hosts', () => withPackage((dir) => {
    const pkg = baseManifest()
    pkg.mim.permissions = { http: ['https://api.example.com/path'] } as any

    const result = parsePackageManifest(pkg, dir)

    expect(result.manifest).toBeNull()
    expect(result.diagnostics.some(d => d.message.includes('Invalid HTTP permission host'))).toBe(true)
  }))

  it('warns about unknown mim keys but still loads the manifest; allows x-prefixed extension keys', () => withPackage((dir) => {
    const pkg = baseManifest()
    ;(pkg.mim as Record<string, unknown>).surprise = true
    ;(pkg.mim as Record<string, unknown>)['x-local-note'] = true

    const result = parsePackageManifest(pkg, dir)

    // Unknown keys are warnings: the manifest loads, diagnostics are carried.
    expect(result.manifest).not.toBeNull()
    expect(result.manifest?.id).toBe('test-package')
    expect(result.diagnostics.some(d => d.message.includes('surprise'))).toBe(true)
    expect(result.diagnostics.some(d => d.message.includes('x-local-note'))).toBe(false)
  }))
})

// ---------------------------------------------------------------------------
// provides.tools
// ---------------------------------------------------------------------------

describe('provides.tools grants', () => {
  function withPackage(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'mim-manifest-test-'))
    mkdirSync(join(dir, 'ui'), { recursive: true })
    writeFileSync(join(dir, 'ui', 'index.html'), '<h1>Package</h1>')
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  function baseManifest(provides?: unknown) {
    return {
      name: '@mim/test',
      version: '0.1.0',
      mim: {
        manifestVersion: 1,
        id: 'test-package',
        name: 'Test Package',
        views: [{ id: 'main', label: 'Main', src: './ui/index.html', role: 'work' }],
        permissions: {},
        ...(provides !== undefined ? { provides } : {}),
      },
    }
  }

  it('parses string shorthand with defaults (category general, risk medium)', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({ tools: ['issues.list'] }), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.provides).toEqual({
      tools: [{ pattern: 'issues.list', category: 'general', risk: 'medium' }],
    })
  }))

  it('parses object form with explicit category and risk', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: [{ name: 'issues.create', category: 'write', risk: 'low' }],
    }), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.provides).toEqual({
      tools: [{ pattern: 'issues.create', category: 'write', risk: 'low' }],
    })
  }))

  it('accepts wildcard patterns', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({ tools: ['issues.*'] }), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.provides?.tools[0].pattern).toBe('issues.*')
  }))

  it('wildcard patterns are not floored (deferred to runtime)', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: [{ name: 'issues.*', category: 'write', risk: 'low' }],
    }), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.provides?.tools[0].risk).toBe('low')
  }))

  it('drops entries with invalid patterns and emits diagnostic', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: ['singleword', 'issues.list'],
    }), dir)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toContain('invalid pattern')
    // valid entry still parsed
    expect(result.manifest?.provides?.tools).toEqual([
      { pattern: 'issues.list', category: 'general', risk: 'medium' },
    ])
  }))

  it('rejects patterns longer than 80 chars', () => withPackage((dir) => {
    const long = 'a.' + 'b'.repeat(79)
    const result = parsePackageManifest(baseManifest({ tools: [long] }), dir)
    expect(result.diagnostics.some(d => d.message.includes('invalid pattern'))).toBe(true)
  }))

  it('rejects patterns with uppercase segments', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({ tools: ['Issues.List'] }), dir)
    expect(result.diagnostics.some(d => d.message.includes('invalid pattern'))).toBe(true)
  }))

  it('rejects wildcard not in final position', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({ tools: ['*.issues.list'] }), dir)
    expect(result.diagnostics.some(d => d.message.includes('invalid pattern'))).toBe(true)
  }))

  it('coerces system/settings/secrets categories to general with diagnostic', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: [
        { name: 'a.b', category: 'system' },
        { name: 'c.d', category: 'settings' },
        { name: 'e.f', category: 'secrets' },
      ],
    }), dir)
    expect(result.diagnostics).toHaveLength(3)
    for (const d of result.diagnostics) {
      expect(d.message).toContain('reserved')
      expect(d.message).toContain('general')
    }
    expect(result.manifest?.provides?.tools.every(t => t.category === 'general')).toBe(true)
  }))

  it('defaults unknown category to general with diagnostic', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: [{ name: 'a.b', category: 'magic' }],
    }), dir)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toContain('unknown category')
    expect(result.manifest?.provides?.tools[0].category).toBe('general')
  }))

  it('defaults unknown risk to medium with diagnostic', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: [{ name: 'a.b', risk: 'extreme' }],
    }), dir)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toContain('unknown risk')
    expect(result.manifest?.provides?.tools[0].risk).toBe('medium')
  }))

  it('applies risk floor for destructive tool names (delete, remove, purge, destroy, uninstall, reset)', () => withPackage((dir) => {
    const destructiveNames = ['issues.delete', 'pkg.remove', 'data.purge', 'all.destroy', 'pkg.uninstall', 'db.reset']
    const tools = destructiveNames.map(name => ({ name, risk: 'low' }))
    const result = parsePackageManifest(baseManifest({ tools }), dir)

    // Each tool gets a floor diagnostic
    const floorDiags = result.diagnostics.filter(d => d.message.includes('risk floor'))
    expect(floorDiags).toHaveLength(destructiveNames.length)

    // All forced to high
    for (const tool of result.manifest?.provides?.tools ?? []) {
      expect(tool.risk).toBe('high')
    }
  }))

  it('applies risk floor even when no explicit risk is declared (default medium)', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: ['issues.delete'],
    }), dir)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toContain('risk floor')
    expect(result.manifest?.provides?.tools[0].risk).toBe('high')
  }))

  it('does not floor when risk is already high', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: [{ name: 'issues.delete', risk: 'high' }],
    }), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.provides?.tools[0].risk).toBe('high')
  }))

  it('drops non-string non-object entries with diagnostic', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({
      tools: [42, null, 'a.b'],
    }), dir)
    expect(result.diagnostics).toHaveLength(2)
    expect(result.manifest?.provides?.tools).toEqual([
      { pattern: 'a.b', category: 'general', risk: 'medium' },
    ])
  }))

  it('rejects non-object provides with diagnostic', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest('not-an-object'), dir)
    expect(result.diagnostics.some(d => d.message.includes('mim.provides must be an object'))).toBe(true)
  }))

  it('rejects non-array provides.tools with diagnostic', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({ tools: 'issues.*' }), dir)
    expect(result.diagnostics.some(d => d.message.includes('mim.provides.tools must be an array'))).toBe(true)
  }))

  it('returns undefined provides when all entries are invalid (manifest still loads)', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest({ tools: ['bad'] }), dir)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.manifest).toBeDefined()
    expect(result.manifest?.provides).toBeUndefined()
  }))
})

// ---------------------------------------------------------------------------
// dataFolder
// ---------------------------------------------------------------------------

describe('dataFolder', () => {
  function withPackage(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'mim-manifest-test-'))
    mkdirSync(join(dir, 'ui'), { recursive: true })
    writeFileSync(join(dir, 'ui', 'index.html'), '<h1>Package</h1>')
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  function baseManifest(dataFolder?: unknown) {
    return {
      name: '@mim/test',
      version: '0.1.0',
      mim: {
        manifestVersion: 1,
        id: 'test-package',
        name: 'Test Package',
        views: [{ id: 'main', label: 'Main', src: './ui/index.html', role: 'work' }],
        permissions: {},
        ...(dataFolder !== undefined ? { dataFolder } : {}),
      },
    }
  }

  it('accepts a valid folder name', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest('issues'), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.dataFolder).toBe('issues')
  }))

  it('accepts names with hyphens and underscores', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest('my-app_data'), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.dataFolder).toBe('my-app_data')
  }))

  it('rejects names with dots (no traversal) but manifest still loads', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest('some.folder'), dir)
    expect(result.diagnostics.some(d => d.message.includes('invalid folder name'))).toBe(true)
    expect(result.manifest).toBeDefined()
    expect(result.manifest?.dataFolder).toBeUndefined()
  }))

  it('rejects names with slashes', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest('sub/folder'), dir)
    expect(result.diagnostics.some(d => d.message.includes('invalid folder name'))).toBe(true)
  }))

  it('rejects names longer than 40 chars', () => withPackage((dir) => {
    const long = 'a' + 'b'.repeat(40) // 41 chars
    const result = parsePackageManifest(baseManifest(long), dir)
    expect(result.diagnostics.some(d => d.message.includes('invalid folder name'))).toBe(true)
  }))

  it('rejects reserved names but manifest still loads', () => withPackage((dir) => {
    for (const name of ['packages', 'skills', 'node_modules', 'sessions']) {
      const result = parsePackageManifest(baseManifest(name), dir)
      expect(result.diagnostics.some(d => d.message.includes('reserved'))).toBe(true)
      expect(result.manifest).toBeDefined()
      expect(result.manifest?.dataFolder).toBeUndefined()
    }
  }))

  it('rejects names starting with a hyphen', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest('-bad'), dir)
    expect(result.diagnostics.some(d => d.message.includes('invalid folder name'))).toBe(true)
  }))

  it('omits dataFolder when not declared', () => withPackage((dir) => {
    const result = parsePackageManifest(baseManifest(), dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest?.dataFolder).toBeUndefined()
  }))
})

// ---------------------------------------------------------------------------
// Back-compat: manifest without provides/dataFolder still parses identically
// ---------------------------------------------------------------------------

describe('back-compat', () => {
  function withPackage(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'mim-manifest-test-'))
    mkdirSync(join(dir, 'ui'), { recursive: true })
    writeFileSync(join(dir, 'ui', 'index.html'), '<h1>Package</h1>')
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('manifest without provides or dataFolder parses with no diagnostics', () => withPackage((dir) => {
    const pkg = {
      name: '@mim/test',
      version: '1.0.0',
      mim: {
        manifestVersion: 1,
        id: 'classic-pkg',
        name: 'Classic Package',
        views: [{ id: 'main', label: 'Main', src: './ui/index.html', role: 'work' }],
        permissions: { workspace: { read: true } },
      },
    }
    const result = parsePackageManifest(pkg, dir)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest).toBeDefined()
    expect(result.manifest?.provides).toBeUndefined()
    expect(result.manifest?.dataFolder).toBeUndefined()
    expect(result.manifest?.id).toBe('classic-pkg')
  }))
})

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

describe('matchesToolGrant', () => {
  it('exact match', () => {
    expect(matchesToolGrant('issues.list', 'issues.list')).toBe(true)
  })

  it('exact non-match', () => {
    expect(matchesToolGrant('issues.list', 'issues.create')).toBe(false)
  })

  it('wildcard matches same-prefix names', () => {
    expect(matchesToolGrant('issues.*', 'issues.list')).toBe(true)
    expect(matchesToolGrant('issues.*', 'issues.create')).toBe(true)
  })

  it('wildcard matches multi-segment suffixes', () => {
    expect(matchesToolGrant('issues.*', 'issues.board.list')).toBe(true)
  })

  it('wildcard does not match prefix-but-no-dot (issuesx.list)', () => {
    expect(matchesToolGrant('issues.*', 'issuesx.list')).toBe(false)
  })

  it('wildcard does not match the bare prefix (issues.)', () => {
    expect(matchesToolGrant('issues.*', 'issues.')).toBe(false)
  })

  it('non-wildcard pattern does not match a longer name', () => {
    expect(matchesToolGrant('issues.list', 'issues.list.all')).toBe(false)
  })
})

describe('applyToolRiskFloor', () => {
  it('floors delete to high', () => {
    expect(applyToolRiskFloor('issues.delete', 'low')).toBe('high')
    expect(applyToolRiskFloor('issues.delete', 'medium')).toBe('high')
  })

  it('does not floor non-destructive names', () => {
    expect(applyToolRiskFloor('issues.list', 'low')).toBe('low')
    expect(applyToolRiskFloor('issues.create', 'medium')).toBe('medium')
  })

  it('preserves high for destructive names', () => {
    expect(applyToolRiskFloor('issues.delete', 'high')).toBe('high')
  })

  it('floors all destructive segment names', () => {
    for (const seg of ['delete', 'remove', 'purge', 'destroy', 'uninstall', 'reset']) {
      expect(applyToolRiskFloor(`pkg.${seg}`, 'low')).toBe('high')
    }
  })
})

describe('isValidPublicToolName', () => {
  it('accepts dotted lowercase names with >=2 segments', () => {
    expect(isValidPublicToolName('issues.list')).toBe(true)
    expect(isValidPublicToolName('issues.board.list')).toBe(true)
  })

  it('rejects single-segment names', () => {
    expect(isValidPublicToolName('issues')).toBe(false)
  })

  it('rejects wildcard', () => {
    expect(isValidPublicToolName('issues.*')).toBe(false)
  })

  it('rejects uppercase', () => {
    expect(isValidPublicToolName('Issues.List')).toBe(false)
  })

  it('rejects names over 80 chars', () => {
    expect(isValidPublicToolName('a.' + 'b'.repeat(80))).toBe(false)
  })

  it('accepts names with hyphens and underscores', () => {
    expect(isValidPublicToolName('my-pkg.tool_name')).toBe(true)
  })

  it('rejects segments starting with hyphen', () => {
    expect(isValidPublicToolName('issues.-list')).toBe(false)
  })
})
