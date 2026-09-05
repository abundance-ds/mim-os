import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  syncTeamFilesMount,
  teamFilesMountPath,
  teamMountPath,
  teamMountSymlinkType,
} from '@main/team/teamFiles.js'
import type { TeamCheckout } from '@main/team/teamSource.js'

describe('Team Files mount', () => {
  let workspace: string
  let checkoutRoot: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mim-team-files-workspace-'))
    checkoutRoot = mkdtempSync(join(tmpdir(), 'mim-team-files-checkout-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  })

  function checkout(root = checkoutRoot): TeamCheckout {
    return {
      name: 'Acme Research',
      root,
      manifestPath: join(root, 'team.yaml'),
      instructionsPath: null,
      filesPath: join(root, 'files'),
      skillsPath: join(root, 'skills'),
      appsPath: join(root, 'apps'),
      routinesPath: join(root, 'routines'),
      contributions: {
        instructions: false,
        files: 0,
        skills: 0,
        apps: 0,
        routines: 0,
      },
    }
  }

  it('mounts the connected Team checkout at .mim/team', () => {
    const result = syncTeamFilesMount(workspace, checkout())
    const mount = teamMountPath(workspace)

    expect(result).toEqual({ mounted: true, removed: false, conflict: false })
    expect(lstatSync(mount).isSymbolicLink()).toBe(true)
    expect(readlinkSync(mount)).toBe(checkoutRoot)
    expect(teamFilesMountPath(workspace)).toBe(join(workspace, '.mim', 'team', 'files'))
  })

  it('keeps the mount writable even when the optional files directory is absent', () => {
    syncTeamFilesMount(workspace, checkout())

    expect(existsSync(teamFilesMountPath(workspace))).toBe(false)
    mkdirSync(teamFilesMountPath(workspace), { recursive: true })
    writeFileSync(join(teamFilesMountPath(workspace), 'brief.md'), 'Shared work')

    expect(existsSync(join(checkoutRoot, 'files', 'brief.md'))).toBe(true)
  })

  it('is idempotent and retargets a stale Team symlink', () => {
    syncTeamFilesMount(workspace, checkout())
    expect(syncTeamFilesMount(workspace, checkout())).toEqual({
      mounted: true,
      removed: false,
      conflict: false,
    })

    const replacement = mkdtempSync(join(tmpdir(), 'mim-team-files-replacement-'))
    try {
      syncTeamFilesMount(workspace, checkout(replacement))
      expect(readlinkSync(teamMountPath(workspace))).toBe(replacement)
    } finally {
      rmSync(replacement, { recursive: true, force: true })
    }
  })

  it('removes only a managed symlink when the Team disconnects', () => {
    syncTeamFilesMount(workspace, checkout())

    expect(syncTeamFilesMount(workspace, null)).toEqual({
      mounted: false,
      removed: true,
      conflict: false,
    })
    expect(existsSync(teamMountPath(workspace))).toBe(false)
  })

  it('never overwrites or removes a real .mim/team directory', () => {
    mkdirSync(teamMountPath(workspace), { recursive: true })
    writeFileSync(join(teamMountPath(workspace), 'keep.txt'), 'mine')

    expect(syncTeamFilesMount(workspace, checkout())).toEqual({
      mounted: false,
      removed: false,
      conflict: true,
    })
    expect(syncTeamFilesMount(workspace, null)).toEqual({
      mounted: false,
      removed: false,
      conflict: true,
    })
    expect(existsSync(join(teamMountPath(workspace), 'keep.txt'))).toBe(true)
  })

  it('uses a directory symlink on POSIX and a junction on Windows', () => {
    expect(teamMountSymlinkType('linux')).toBe('dir')
    expect(teamMountSymlinkType('darwin')).toBe('dir')
    expect(teamMountSymlinkType('win32')).toBe('junction')
  })

  it('removes a dangling managed symlink on disconnect', () => {
    mkdirSync(join(workspace, '.mim'), { recursive: true })
    symlinkSync(join(workspace, 'gone'), teamMountPath(workspace), teamMountSymlinkType())

    expect(syncTeamFilesMount(workspace, null)).toEqual({
      mounted: false,
      removed: true,
      conflict: false,
    })
    expect(existsSync(teamMountPath(workspace))).toBe(false)
  })
})
