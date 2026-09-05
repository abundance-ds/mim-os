import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createSkillLoader, resolveBuiltinSkillsDir } from '@main/skills.js'

function writeSkill(root: string, name: string, frontmatter: string, body = '# Body\n\nUse carefully.'): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`, 'utf-8')
}

describe('filesystem skill loader', () => {
  let root: string
  let builtinDir: string
  let personalDir: string
  let sourceDir: string
  let workspaceDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mim-skills-'))
    builtinDir = join(root, 'builtin-skills')
    personalDir = join(root, 'personal-skills')
    sourceDir = join(root, 'source-skills')
    workspaceDir = join(root, 'workspace')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('loads SKILL.md frontmatter and keeps body out of list metadata', () => {
    writeSkill(builtinDir, 'issue-work', [
      'name: issue-work',
      'description: Use when the user is planning or updating Mim issues.',
      'tools: [issues.list, issues.update]',
    ].join('\n'))

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.list()).toEqual([
      {
        id: 'issue-work',
        name: 'issue-work',
        description: 'Use when the user is planning or updating Mim issues.',
        tools: ['issues.list', 'issues.update'],
        unlocks: [],
        source: 'mim',
        dir: join(builtinDir, 'issue-work'),
        path: join(builtinDir, 'issue-work', 'SKILL.md'),
        editorPath: '.mim/origins/mim/skills/issue-work/SKILL.md',
        diagnostics: [],
      },
    ])
    expect(loader.list()[0]).not.toHaveProperty('body')
    expect(loader.get('issue-work')?.body).toContain('Use carefully.')
  })

  it('lets Project skills shadow Personal, Team, and Mim skills by folder name', () => {
    writeSkill(builtinDir, 'issue-work', 'name: issue-work\ndescription: Builtin')
    writeSkill(sourceDir, 'issue-work', 'name: issue-work\ndescription: Source')
    writeSkill(personalDir, 'issue-work', 'name: issue-work\ndescription: Personal')
    writeSkill(join(workspaceDir, 'skills'), 'issue-work', 'name: issue-work\ndescription: Workspace')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      teamDir: sourceDir,
      teamName: 'Team',
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.get('issue-work')).toMatchObject({
      name: 'issue-work',
      description: 'Workspace',
      source: 'project',
    })
    expect(loader.listDetailed()[0].shadows.map(skill => skill.source)).toEqual(['mim', 'team', 'personal'])
    expect(loader.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'issue-work', message: expect.stringContaining('shadowed') }),
    ]))
  })

  it('resolves authored skills in Project, You, Team, then Mim precedence', () => {
    writeSkill(builtinDir, 'project-wins', 'name: project-wins\ndescription: Mim')
    writeSkill(sourceDir, 'project-wins', 'name: project-wins\ndescription: Team')
    writeSkill(personalDir, 'project-wins', 'name: project-wins\ndescription: You')
    writeSkill(join(workspaceDir, 'skills'), 'project-wins', 'name: project-wins\ndescription: Project')

    writeSkill(builtinDir, 'you-win', 'name: you-win\ndescription: Mim')
    writeSkill(sourceDir, 'you-win', 'name: you-win\ndescription: Team')
    writeSkill(personalDir, 'you-win', 'name: you-win\ndescription: You')

    writeSkill(builtinDir, 'team-wins', 'name: team-wins\ndescription: Mim')
    writeSkill(sourceDir, 'team-wins', 'name: team-wins\ndescription: Team')

    writeSkill(builtinDir, 'mim-wins', 'name: mim-wins\ndescription: Mim')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      teamDir: sourceDir,
      teamName: 'Acme Research',
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.get('project-wins')).toMatchObject({ source: 'project', description: 'Project' })
    expect(loader.get('you-win')).toMatchObject({ source: 'personal', description: 'You' })
    expect(loader.get('team-wins')).toMatchObject({ source: 'team', description: 'Team', sourceName: 'Acme Research' })
    expect(loader.get('mim-wins')).toMatchObject({ source: 'mim', description: 'Mim' })
  })

  it('diagnoses invalid skill frontmatter without failing the catalog', () => {
    writeSkill(builtinDir, 'wrong-folder', 'name: other\ndescription: Bad')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.list()).toEqual([])
    expect(loader.diagnostics()).toEqual([
      expect.objectContaining({
        name: 'wrong-folder',
        message: expect.stringContaining('must match folder name'),
      }),
    ])
  })

  it('scans app skill roots with app source', () => {
    const pkgDir = join(root, 'pkg-skills')
    writeSkill(pkgDir, 'my-skill', 'name: my-skill\ndescription: From app')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getPackageSkillRoots: () => [{ packageId: 'review-app', packageName: 'Review App', dir: pkgDir }],
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.get('package:review-app/my-skill')).toMatchObject({
      id: 'package:review-app/my-skill',
      name: 'my-skill',
      description: 'From app',
      source: 'package',
      packageId: 'review-app',
    })
  })

  it('keeps app skills in a separate namespace from authored skills', () => {
    const pkgDir = join(root, 'pkg-skills')
    writeSkill(pkgDir, 'shared', 'name: shared\ndescription: App version')
    writeSkill(personalDir, 'shared', 'name: shared\ndescription: Personal version')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getPackageSkillRoots: () => [{ packageId: 'writer', packageName: 'Writer', dir: pkgDir }],
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.get('shared')).toMatchObject({
      id: 'shared',
      source: 'personal',
      description: 'Personal version',
    })
    expect(loader.get('package:writer/shared')).toMatchObject({
      id: 'package:writer/shared',
      source: 'package',
      description: 'App version',
    })
    expect(loader.listDetailed().map(skill => skill.id)).toEqual(['shared'])
  })

  it('resolves package skills by short name when no authored skill shadows them', () => {
    const pkgDir = join(root, 'pkg-skills')
    writeSkill(pkgDir, 'knowledge', 'name: knowledge\ndescription: Knowledge tools')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getPackageSkillRoots: () => [{ packageId: 'knowledge', packageName: 'Knowledge', dir: pkgDir }],
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.get('knowledge')).toMatchObject({
      id: 'package:knowledge/knowledge',
      name: 'knowledge',
      source: 'package',
    })
    expect(loader.get('package:knowledge/knowledge')).toMatchObject({
      id: 'package:knowledge/knowledge',
      name: 'knowledge',
      source: 'package',
    })
  })

  it('tolerates an app root that does not exist', () => {
    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getPackageSkillRoots: () => [{ packageId: 'missing', dir: join(root, 'does-not-exist') }],
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.list()).toEqual([])
  })

  it('swallows provider errors from getPackageSkillRoots', () => {
    writeSkill(builtinDir, 'ok', 'name: ok\ndescription: Still loads')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getPackageSkillRoots: () => { throw new Error('provider broke') },
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.list()).toEqual([
      expect.objectContaining({ name: 'ok', source: 'mim' }),
    ])
  })

  it('parses unlocks frontmatter, defaults to empty array', () => {
    writeSkill(builtinDir, 'with-unlocks', [
      'name: with-unlocks',
      'description: Has unlocks',
      'tools: [issues.list]',
      'unlocks: [issues.list, issues.update]',
    ].join('\n'))
    writeSkill(personalDir, 'no-unlocks', 'name: no-unlocks\ndescription: No unlocks declared')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.get('with-unlocks')?.unlocks).toEqual(['issues.list', 'issues.update'])
    expect(loader.get('no-unlocks')?.unlocks).toEqual([])
  })

  it('loads the bundled build-app skill with app authoring unlocks', () => {
    const builtinSkillsDir = resolveBuiltinSkillsDir()
    expect(existsSync(join(builtinSkillsDir, 'build-app', 'SKILL.md'))).toBe(true)

    const loader = createSkillLoader({
      personalDir,
      getWorkspacePath: () => workspaceDir,
    })
    const skill = loader.get('build-app')

    expect(skill).toMatchObject({
      id: 'build-app',
      name: 'build-app',
      source: 'mim',
    })
    expect(skill?.description).toContain('teach Mim a recurring capability')
    expect(skill?.unlocks).toEqual(expect.arrayContaining([
      'package_create',
      'package_validate',
      'package_reload',
      'app_status',
      'app_enable',
      'package_tools_execute',
      'package_jobs_start',
    ]))
    expect(skill?.body).toContain('Trust Boundary')
  })

  it('does not scan the same authored skill root twice', () => {
    const sameWorkspace = join(root, 'same-workspace')
    const sharedSkillsDir = join(sameWorkspace, 'skills')
    writeSkill(sharedSkillsDir, 'build-app', 'name: build-app\ndescription: Shared root')

    const loader = createSkillLoader({
      builtinDir: sharedSkillsDir,
      personalDir,
      getWorkspacePath: () => sameWorkspace,
    })

    expect(loader.get('build-app')).toMatchObject({
      name: 'build-app',
      source: 'mim',
    })
    expect(loader.diagnostics()).toEqual([])
  })

  it('filters disabled skills after last-wins resolution', () => {
    writeSkill(builtinDir, 'issue-work', 'name: issue-work\ndescription: Builtin')
    writeSkill(join(workspaceDir, 'skills'), 'issue-work', 'name: issue-work\ndescription: Workspace')
    writeSkill(builtinDir, 'other-work', 'name: other-work\ndescription: Other')
    const pkgDir = join(root, 'pkg-skills')
    writeSkill(pkgDir, 'issue-work', 'name: issue-work\ndescription: App')

    const loader = createSkillLoader({
      builtinDir,
      personalDir,
      getPackageSkillRoots: () => [{ packageId: 'issues', dir: pkgDir }],
      disabledNames: new Set(['issue-work']),
      getWorkspacePath: () => workspaceDir,
    })

    expect(loader.list().map(skill => skill.id)).toEqual(['other-work', 'package:issues/issue-work'])
    expect(loader.get('issue-work')).toBeUndefined()
    expect(loader.get('package:issues/issue-work')).toMatchObject({ source: 'package' })
    expect(loader.listDetailed()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'issue-work',
        name: 'issue-work',
        source: 'project',
        enabled: false,
        shadows: [expect.objectContaining({ source: 'mim' })],
      }),
    ]))
  })
})
