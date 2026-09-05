import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assertTeamReleaseContents,
  buildTeamReleaseIndex,
} from './teamReleaseContents.js'

describe('Team release content integrity', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mim-team-release-content-'))
    mkdirSync(join(root, 'apps', 'knowledge', 'backend'), { recursive: true })
    mkdirSync(join(root, 'skills', 'review-notes'), { recursive: true })
    mkdirSync(join(root, 'files'), { recursive: true })
    mkdirSync(join(root, 'routines'), { recursive: true })
    writeFileSync(join(root, 'apps', 'knowledge', 'package.json'), JSON.stringify({
      name: '@test/knowledge',
      version: '1.2.0',
      mim: {
        manifestVersion: 1,
        id: 'knowledge',
        name: 'Knowledge',
        description: 'Shared knowledge',
        views: [],
        backend: './backend/index.mjs',
        permissions: { workspace: { read: true } },
        engines: { mim: 'runtime-v1' },
      },
    }, null, 2))
    writeFileSync(join(root, 'apps', 'knowledge', 'backend', 'index.mjs'), 'export const tools = {}\n')
    writeFileSync(join(root, 'skills', 'review-notes', 'SKILL.md'), [
      '---',
      'name: review-notes',
      'version: 1.0.0',
      'description: Review notes.',
      '---',
      '',
      '# Review notes',
    ].join('\n'))
    writeFileSync(join(root, 'files', 'handbook.md'), '# Handbook\n')
    writeFileSync(join(root, 'routines', 'daily.yaml'), 'name: Daily\n')
    writeFileSync(join(root, 'instructions.md'), '# Guidance\n')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('rebuilds the deterministic release boundary from actual Team content', () => {
    const index = buildTeamReleaseIndex(root, 'Acme Research')

    expect(index.apps[0]).toMatchObject({
      id: 'knowledge',
      version: '1.2.0',
      execution: { backend: true, tui: false },
      permissions: { workspace: { read: true } },
    })
    expect(index.files.map(entry => entry.path)).toEqual(['handbook.md'])
    expect(index.routines.map(entry => entry.path)).toEqual(['daily.yaml'])
    expect(() => assertTeamReleaseContents(root, index)).not.toThrow()
  })

  it('rejects an index that hides changed code or declared access', () => {
    const index = buildTeamReleaseIndex(root, 'Acme Research')
    writeFileSync(join(root, 'apps', 'knowledge', 'backend', 'index.mjs'), 'export const tools = { changed: true }\n')
    expect(() => assertTeamReleaseContents(root, index)).toThrow('does not match')

    const current = buildTeamReleaseIndex(root, 'Acme Research')
    current.apps[0].permissions = {}
    expect(() => assertTeamReleaseContents(root, current)).toThrow('does not match')
  })

  it('rejects contribution symlinks instead of releasing content outside the Team', () => {
    symlinkSync(join(root, 'instructions.md'), join(root, 'files', 'linked.md'))
    expect(() => buildTeamReleaseIndex(root, 'Acme Research')).toThrow('symbolic links')
  })
})
