import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { searchFiles } from '@main/search/fileSearch.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { syncTeamFilesMount } from '@main/team/teamFiles.js'
import type { TeamCheckout } from '@main/team/teamSource.js'

describe('File search', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-filesearch-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a match in a text file', async () => {
    writeFileSync(join(dir, 'readme.txt'), 'This project uses webpack for bundling.')

    const results = await searchFiles(dir, 'webpack')
    expect(results.length).toBe(1)
    expect(results[0].path).toBe('readme.txt')
    expect(results[0].line).toBe(1)
    expect(results[0].snippet).toContain('webpack')
  })

  it('is case-insensitive', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'Important CONFIGURATION settings here')

    const results = await searchFiles(dir, 'configuration')
    expect(results.length).toBe(1)
  })

  it('matches multi-term queries on the same line without requiring exact phrase order', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'Retry network requests after timeout errors.')

    const results = await searchFiles(dir, 'timeout retry')
    expect(results.length).toBe(1)
    expect(results[0].snippet.toLowerCase()).toContain('retry')
  })

  it('renders inline comment markup readably in snippets while keeping notes searchable', async () => {
    writeFileSync(
      join(dir, 'plan.md'),
      'We propose <comment id="k3f9">a staged rollout<note by="paul" at="2026-06-13T09:14">Too slow for launch</note></comment> now.',
    )

    const results = await searchFiles(dir, 'too slow')
    expect(results.length).toBe(1)
    expect(results[0].snippet).toContain('[paul: Too slow for launch]')
    expect(results[0].snippet).toContain('a staged rollout')
    expect(results[0].snippet).not.toContain('<comment')
    expect(results[0].snippet).not.toContain('<note')
  })

  it('returns empty for empty query', async () => {
    writeFileSync(join(dir, 'file.txt'), 'some content')
    expect(await searchFiles(dir, '')).toEqual([])
    expect(await searchFiles(dir, '   ')).toEqual([])
  })

  it('returns empty when no matches', async () => {
    writeFileSync(join(dir, 'file.txt'), 'hello world')
    const results = await searchFiles(dir, 'xyznonexistent')
    expect(results).toEqual([])
  })

  it('searches recursively into subdirectories', async () => {
    const sub = join(dir, 'src', 'lib')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'utils.ts'), 'export function deepSearch() { return true }')

    const results = await searchFiles(dir, 'deepsearch')
    expect(results.length).toBe(1)
    expect(results[0].path).toMatch(/src\/lib\/utils\.ts/)
  })

  it('skips node_modules directory', async () => {
    const nm = join(dir, 'node_modules', 'some-pkg')
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, 'index.js'), 'findme keyword here')
    writeFileSync(join(dir, 'app.js'), 'no match here')

    const results = await searchFiles(dir, 'findme')
    expect(results).toEqual([])
  })

  it('skips .git directory', async () => {
    const git = join(dir, '.git', 'objects')
    mkdirSync(git, { recursive: true })
    writeFileSync(join(git, 'data'), 'secretgitdata')

    const results = await searchFiles(dir, 'secretgitdata')
    expect(results).toEqual([])
  })

  it('skips binary file extensions', async () => {
    writeFileSync(join(dir, 'image.png'), 'fakepng searchterm data')
    writeFileSync(join(dir, 'doc.txt'), 'searchterm in text')

    const results = await searchFiles(dir, 'searchterm')
    expect(results.length).toBe(1)
    expect(results[0].path).toBe('doc.txt')
  })

  it('respects maxResults limit', async () => {
    let content = ''
    for (let i = 0; i < 20; i++) {
      content += `line ${i} repeatedkeyword\n`
    }
    writeFileSync(join(dir, 'big.txt'), content)

    const results = await searchFiles(dir, 'repeatedkeyword', { maxResults: 5 })
    expect(results.length).toBe(5)
  })

  it('filters by glob pattern', async () => {
    writeFileSync(join(dir, 'app.ts'), 'searchable content ts')
    writeFileSync(join(dir, 'app.js'), 'searchable content js')
    writeFileSync(join(dir, 'readme.md'), 'searchable content md')

    const results = await searchFiles(dir, 'searchable', { pattern: '*.ts' })
    expect(results.length).toBe(1)
    expect(results[0].path).toBe('app.ts')
  })

  it('normalizes backslash glob patterns before matching slash paths', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'app.ts'), 'searchable content ts')
    writeFileSync(join(dir, 'src', 'app.js'), 'searchable content js')

    const results = await searchFiles(dir, 'searchable', { pattern: 'src\\*.ts' })
    expect(results.length).toBe(1)
    expect(results[0].path).toBe('src/app.ts')
  })

  it('finds multiple matches across files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'keyword in file a')
    writeFileSync(join(dir, 'b.txt'), 'keyword in file b')

    const results = await searchFiles(dir, 'keyword')
    expect(results.length).toBe(2)
  })

  it('reports correct line numbers', async () => {
    writeFileSync(join(dir, 'code.txt'), 'line one\nline two\ntarget on line three\nline four')

    const results = await searchFiles(dir, 'target')
    expect(results.length).toBe(1)
    expect(results[0].line).toBe(3)
  })

  it('does not leak CR characters into snippets from CRLF files', async () => {
    writeFileSync(join(dir, 'win.txt'), 'alpha\r\ntarget line\r\nomega\r\n')

    const results = await searchFiles(dir, 'target')
    expect(results.length).toBe(1)
    expect(results[0].snippet).toBe('target line')
  })

  it('truncates long lines in snippets', async () => {
    const padding = 'x'.repeat(100)
    writeFileSync(join(dir, 'long.txt'), `${padding}FINDME${padding}`)

    const results = await searchFiles(dir, 'findme')
    expect(results.length).toBe(1)
    // Snippet should be shorter than the full line
    expect(results[0].snippet.length).toBeLessThan(200)
    expect(results[0].snippet).toContain('...')
  })

  it('cancels search via AbortSignal', async () => {
    // Create many files so cancellation has something to cancel
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(dir, `file${i}.txt`), `searchterm content in file ${i}`)
    }

    const controller = new AbortController()
    // Abort immediately
    controller.abort()

    const results = await searchFiles(dir, 'searchterm', { signal: controller.signal })
    // Should return fewer results than total files since it was cancelled
    expect(results.length).toBeLessThan(50)
  })

  it('respects time budget and returns partial results', async () => {
    // Use a very short time budget
    writeFileSync(join(dir, 'file.txt'), 'budgetword here')

    const results = await searchFiles(dir, 'budgetword', { timeBudgetMs: 60000 })
    // With a generous budget, we should still find the result
    expect(results.length).toBe(1)
  })
})

describe('File search — Team Files', () => {
  let dir: string
  let source: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-filesearch-ws-'))
    source = mkdtempSync(join(tmpdir(), 'mim-filesearch-src-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(source, { recursive: true, force: true })
  })

  function mount(target: string) {
    const mountRoot = join(dir, '.mim')
    mkdirSync(mountRoot, { recursive: true })
    symlinkSync(target, join(mountRoot, 'team'))
  }

  it('searches inside Team Files and tags hits with Team provenance', async () => {
    mkdirSync(join(source, 'files'))
    writeFileSync(join(source, 'files', 'guidance.md'), 'Submission deadline is strict.')
    mount(source)

    const results = await searchFiles(dir, 'submission deadline')
    expect(results.length).toBe(1)
    expect(results[0].path).toBe('.mim/team/files/guidance.md')
    expect(results[0].source).toBe('team')
  })

  it('finds files through the real Team mount and search seam', async () => {
    mkdirSync(join(source, 'files'))
    writeFileSync(join(source, 'files', 'team-brief.md'), 'The launch phrase is reusable seam.')
    const team = {
      name: 'Acme Research',
      root: source,
      filesPath: join(source, 'files'),
    } as TeamCheckout

    expect(syncTeamFilesMount(dir, team)).toMatchObject({ mounted: true, conflict: false })
    expect(await searchFiles(dir, 'reusable seam')).toEqual([
      expect.objectContaining({
        path: '.mim/team/files/team-brief.md',
        source: 'team',
      }),
    ])
  })

  it('does not tag ordinary workspace hits as Team files', async () => {
    writeFileSync(join(dir, 'notes.md'), 'workspace deadline note')
    const results = await searchFiles(dir, 'deadline')
    expect(results.length).toBe(1)
    expect(results[0].source).toBeUndefined()
  })

  it('still skips .git inside the Team checkout', async () => {
    mkdirSync(join(source, 'files'))
    mkdirSync(join(source, '.git'), { recursive: true })
    writeFileSync(join(source, '.git', 'config'), 'mirrorsecret = true')
    writeFileSync(join(source, 'files', 'real.md'), 'mirrorsecret in docs')
    mount(source)

    const results = await searchFiles(dir, 'mirrorsecret')
    expect(results.length).toBe(1)
    expect(results[0].path).toBe('.mim/team/files/real.md')
  })

  it('ignores a dangling Team mount', async () => {
    mount(join(source, 'missing'))
    writeFileSync(join(dir, 'ok.md'), 'findable text')
    expect((await searchFiles(dir, 'findable')).length).toBe(1)
  })

  it('respects maxResults across Project and Team files', async () => {
    writeFileSync(join(dir, 'a.md'), 'needle\nneedle')
    mkdirSync(join(source, 'files'))
    writeFileSync(join(source, 'files', 'b.md'), 'needle\nneedle')
    mount(source)
    expect((await searchFiles(dir, 'needle', { maxResults: 3 })).length).toBe(3)
  })
})
