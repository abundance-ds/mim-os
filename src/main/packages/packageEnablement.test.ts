import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createPackageEnablementStore } from './packageEnablement.js'
import type { LoadedPackage } from './packages.js'

describe('per-person, per-Project app activation', () => {
  let project: string

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'mim-app-activation-'))
  })

  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  function app(id: string, source: LoadedPackage['source'], powerful = false) {
    return {
      source,
      dir: join(project, 'packages', id),
      manifest: {
        manifestVersion: 1 as const,
        id,
        name: id,
        version: '1.0.0',
        views: [],
        ...(powerful ? { backend: './backend/index.mjs' } : {}),
        permissions: {},
      },
    }
  }

  it('keeps every origin disabled until this person enables it', () => {
    const store = createPackageEnablementStore({ getWorkspacePath: () => project })
    expect(store.isEnabled(app('mim-app', 'mim'))).toBe(false)
    expect(store.isEnabled(app('team-app', 'team'))).toBe(false)
    expect(store.isEnabled(app('project-app', 'project'))).toBe(false)
  })

  it('writes activation only to local Project state', () => {
    const store = createPackageEnablementStore({ getWorkspacePath: () => project })
    store.setEnabled('team-app', true)
    store.setEnabled('mim-app', false)

    expect(JSON.parse(readFileSync(
      join(project, '.mim', 'packages', 'enabled.json'),
      'utf-8',
    ))).toEqual({
      enabled: ['team-app'],
      disabled: ['mim-app'],
      trusted: [],
    })
  })

  it('reviews Team and Project code locally while trusting Mim code', () => {
    const store = createPackageEnablementStore({ getWorkspacePath: () => project })
    const teamApp = app('team-code', 'team', true)
    const projectApp = app('project-code', 'project', true)
    const mimApp = app('mim-code', 'mim', true)

    expect(store.needsTrust(teamApp)).toBe(true)
    expect(store.needsTrust(projectApp)).toBe(true)
    expect(store.needsTrust(mimApp)).toBe(false)

    store.ackTrust(teamApp)
    store.setEnabled('team-code', true)
    expect(store.isEnabled(teamApp)).toBe(true)
  })

  it('reviews package-owned terminal code before enabling it', () => {
    const store = createPackageEnablementStore({ getWorkspacePath: () => project })
    const tuiApp = app('team-tui', 'team')
    tuiApp.manifest.tui = { entry: './tui/index.mjs' }

    expect(store.needsTrust(tuiApp)).toBe(true)
    store.ackTrust(tuiApp)
    store.setEnabled('team-tui', true)
    expect(store.isEnabled(tuiApp)).toBe(true)
  })

  it('stores the exact access that was reviewed instead of trusting every future version', () => {
    const store = createPackageEnablementStore({ getWorkspacePath: () => project })
    const teamApp = app('team-code', 'team', true)
    teamApp.manifest.permissions = {
      workspace: { read: true },
      http: ['api.example.com'],
    }

    store.ackTrust(teamApp)

    expect(JSON.parse(readFileSync(
      join(project, '.mim', 'packages', 'enabled.json'),
      'utf-8',
    )).trusted).toEqual([{
      id: 'team-code',
      grants: ['code.backend', 'http:api.example.com', 'workspace.read'],
    }])
  })

  it('asks for review again only when an updated app expands its access', () => {
    const store = createPackageEnablementStore({ getWorkspacePath: () => project })
    const teamApp = app('team-code', 'team', true)
    teamApp.manifest.permissions = { workspace: { read: true } }
    store.ackTrust(teamApp)
    store.setEnabled('team-code', true)

    const reduced = app('team-code', 'team', true)
    expect(store.needsTrust(reduced)).toBe(false)
    expect(store.isEnabled(reduced)).toBe(true)

    const expanded = app('team-code', 'team', true)
    expanded.manifest.permissions = { workspace: { read: true, write: true } }
    expect(store.needsTrust(expanded)).toBe(true)
    expect(store.isEnabled(expanded)).toBe(false)
  })
})
