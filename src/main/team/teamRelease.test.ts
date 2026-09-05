import { describe, expect, it } from 'vitest'
import {
  compareTeamReleases,
  parseTeamRelease,
  type TeamReleaseIndex,
} from './teamRelease.js'

function release(overrides: Partial<TeamReleaseIndex> = {}): TeamReleaseIndex {
  return {
    manifestVersion: 1,
    team: 'Acme Research',
    apps: [],
    skills: [],
    routines: [],
    files: [],
    instructions: null,
    ...overrides,
  }
}

describe('Team release index', () => {
  it('accepts deterministic Team release metadata and rejects malformed indexes', () => {
    const value = release({
      apps: [{
        id: 'knowledge',
        name: 'Knowledge',
        version: '1.2.0',
        digest: 'a'.repeat(64),
        permissions: { workspace: { read: true } },
        execution: { backend: true, tui: false },
        engines: { mim: 'runtime-v1' },
      }],
      skills: [{
        id: 'review-notes',
        name: 'review-notes',
        description: 'Review notes.',
        version: '1.0.1',
        digest: 'b'.repeat(64),
      }],
    })

    expect(parseTeamRelease(JSON.stringify(value))).toEqual(value)
    expect(() => parseTeamRelease('{}')).toThrow('manifestVersion')
    expect(() => parseTeamRelease(JSON.stringify({ ...value, team: '' }))).toThrow('team')
    expect(() => parseTeamRelease(JSON.stringify({
      ...value,
      apps: [{ ...value.apps[0], digest: 'broken' }],
    }))).toThrow('digest')
  })

  it('explains added, updated, and removed capabilities in user-recognizable terms', () => {
    const current = release({
      apps: [{
        id: 'knowledge',
        name: 'Knowledge',
        version: '1.0.0',
        digest: 'a'.repeat(64),
        permissions: { workspace: { read: true } },
        execution: { backend: false, tui: false },
      }, {
        id: 'board',
        name: 'Board',
        version: '1.0.0',
        digest: 'b'.repeat(64),
        permissions: {},
        execution: { backend: false, tui: false },
      }],
      skills: [{
        id: 'old-skill',
        name: 'old-skill',
        description: 'Old.',
        version: '1.0.0',
        digest: 'c'.repeat(64),
      }],
    })
    const available = release({
      apps: [{
        id: 'knowledge',
        name: 'Knowledge',
        version: '1.1.0',
        digest: 'd'.repeat(64),
        permissions: { workspace: { read: true, write: true } },
        execution: { backend: false, tui: false },
      }, {
        id: 'new-app',
        name: 'New App',
        version: '1.0.0',
        digest: '1'.repeat(64),
        permissions: {},
        execution: { backend: true, tui: false },
      }],
      skills: [{
        id: 'review-notes',
        name: 'review-notes',
        description: 'Review notes.',
        version: '1.0.0',
        digest: 'e'.repeat(64),
      }],
      files: [{ path: 'handbook.md', digest: 'f'.repeat(64) }],
    })

    expect(compareTeamReleases(current, available)).toEqual([
      {
        kind: 'app',
        id: 'board',
        name: 'Board',
        action: 'removed',
        currentVersion: '1.0.0',
      },
      {
        kind: 'app',
        id: 'knowledge',
        name: 'Knowledge',
        action: 'updated',
        currentVersion: '1.0.0',
        nextVersion: '1.1.0',
        accessChanged: true,
      },
      {
        kind: 'app',
        id: 'new-app',
        name: 'New App',
        action: 'added',
        nextVersion: '1.0.0',
        accessChanged: true,
      },
      {
        kind: 'skill',
        id: 'old-skill',
        name: 'old-skill',
        action: 'removed',
        currentVersion: '1.0.0',
      },
      {
        kind: 'skill',
        id: 'review-notes',
        name: 'review-notes',
        action: 'added',
        nextVersion: '1.0.0',
      },
      {
        kind: 'file',
        id: 'handbook.md',
        name: 'handbook.md',
        action: 'added',
      },
    ])
  })

  it('does not flag access review when an app keeps or reduces its declared access', () => {
    const current = release({
      apps: [{
        id: 'knowledge',
        name: 'Knowledge',
        version: '1.0.0',
        digest: 'a'.repeat(64),
        permissions: { workspace: { read: true, write: true }, http: ['api.example.com'] },
        execution: { backend: true, tui: true },
      }],
    })
    const available = release({
      apps: [{
        id: 'knowledge',
        name: 'Knowledge',
        version: '1.0.1',
        digest: 'b'.repeat(64),
        permissions: { workspace: { read: true } },
        execution: { backend: true, tui: false },
      }],
    })

    expect(compareTeamReleases(current, available)[0]).not.toHaveProperty('accessChanged')
  })

  it('flags newly executable backend or terminal code as expanded access', () => {
    const current = release({
      apps: [{
        id: 'knowledge',
        name: 'Knowledge',
        version: '1.0.0',
        digest: 'a'.repeat(64),
        permissions: {},
        execution: { backend: false, tui: false },
      }],
    })
    const available = release({
      apps: [{
        id: 'knowledge',
        name: 'Knowledge',
        version: '1.0.1',
        digest: 'b'.repeat(64),
        permissions: {},
        execution: { backend: true, tui: true },
      }],
    })

    expect(compareTeamReleases(current, available)[0]).toMatchObject({
      accessChanged: true,
    })
  })
})
