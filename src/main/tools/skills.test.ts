import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTraceLog } from '@main/trace/trace.js'
import { createSkillLoader } from '@main/skills.js'
import { createToolRegistry } from '@main/tools/registry.js'
import { registerSkillTools } from '@main/tools/skills.js'
import { loadUserConfig, reset as resetUserConfig } from '@main/userConfig.js'

const ctx = { actor: 'user' as const }

describe('skill tools', () => {
  let root: string
  let builtinDir: string
  let home: string
  let workspaceDir: string
  let tools: ReturnType<typeof createToolRegistry>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mim-skill-tools-'))
    home = join(root, 'home')
    builtinDir = join(root, 'builtin-skills')
    workspaceDir = join(root, 'workspace')
    process.env.HOME = home
    resetUserConfig()
    mkdirSync(workspaceDir, { recursive: true })
    const issueSkillDir = join(builtinDir, 'issue-work')
    mkdirSync(issueSkillDir, { recursive: true })
    writeFileSync(join(issueSkillDir, 'SKILL.md'), [
      '---',
      'name: issue-work',
      'description: Use when working with Mim issues.',
      'tools: [issues.list, issues.update]',
      'unlocks: [issues.list, issues.update]',
      '---',
      '',
      '# Issue Work',
      '',
      'Keep issue plans current.',
    ].join('\n'), 'utf-8')

    tools = createToolRegistry(createTraceLog())
    tools.setWorkspacePath(workspaceDir)
    registerSkillTools(tools, {
      homeDir: home,
      builtinDir,
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    resetUserConfig()
  })

  it('declares inputSchema on each skill tool', () => {
    for (const name of [
      'skill.list',
      'skill.get',
      'skill.setDisabled',
      'skill.create',
      'skill.update',
      'skill.templateList',
      'skill.templateContent',
      'skill.inspectImport',
      'skill.import',
      'skill.delete',
      'instruction.list',
      'instruction.open',
    ]) {
      const def = tools.get(name)
      expect(def, name).toBeDefined()
      expect(def!.inputSchema, name).toBeDefined()
      expect((def as Record<string, unknown>).parameters, name).toBeUndefined()
    }
  })

  it('lists skill metadata without loading body text', async () => {
    const result = await tools.call('skill.list', {}, ctx) as { skills: Array<Record<string, unknown>> }

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      name: 'issue-work',
      description: 'Use when working with Mim issues.',
      tools: ['issues.list', 'issues.update'],
      source: 'mim',
    })
    expect(result.skills[0]).not.toHaveProperty('body')
  })

  it('returns the activated skill body and declared tools', async () => {
    const result = await tools.call('skill.get', { name: 'issue-work' }, ctx) as { skill: Record<string, unknown> }

    expect(result.skill).toMatchObject({
      name: 'issue-work',
      body: expect.stringContaining('Keep issue plans current.'),
      tools: ['issues.list', 'issues.update'],
    })
  })

  it('skill.list exposes unlocks array', async () => {
    const result = await tools.call('skill.list', {}, ctx) as { skills: Array<Record<string, unknown>> }

    expect(result.skills[0]).toMatchObject({
      name: 'issue-work',
      unlocks: ['issues.list', 'issues.update'],
    })
  })

  it('disables skills through Personal config and omits them from the active list', async () => {
    await tools.call('skill.setDisabled', { name: 'issue-work', disabled: true }, ctx)

    const active = await tools.call('skill.list', {}, ctx) as { skills: Array<Record<string, unknown>> }
    const detailed = await tools.call('skill.list', { detailed: true }, ctx) as { skills: Array<Record<string, unknown>> }

    expect(active.skills).toEqual([])
    expect(detailed.skills[0]).toMatchObject({ name: 'issue-work', enabled: false })
    expect(loadUserConfig(home).skills.disabled).toEqual(['issue-work'])
  })

  it('creates a personal skill template', async () => {
    const result = await tools.call('skill.create', { name: 'new-skill' }, ctx) as { skill: Record<string, unknown> }

    expect(result.skill).toMatchObject({
      name: 'new-skill',
      source: 'personal',
      dir: join(home, '.mim', 'skills', 'new-skill'),
      path: join(home, '.mim', 'skills', 'new-skill', 'SKILL.md'),
    })
    expect(readFileSync(join(home, '.mim', 'skills', 'new-skill', 'SKILL.md'), 'utf-8')).toContain('## When to use')
    await expect(tools.call('skill.get', { name: 'new-skill' }, ctx)).resolves.toMatchObject({
      skill: {
        name: 'new-skill',
        source: 'personal',
        body: expect.stringContaining('## When to use'),
      },
    })
  })

  it('creates a personal skill from supplied content and extra files', async () => {
    const content = [
      '---',
      'name: review-checklist',
      'description: Use when reviewing a checklist.',
      'tools: [fs_read, fs_write]',
      'unlocks: []',
      '---',
      '',
      '# Review Checklist',
      '',
      'Follow the checklist.',
    ].join('\n')

    const result = await tools.call('skill.create', {
      name: 'review-checklist',
      description: 'Use when reviewing a checklist.',
      content,
      files: {
        'references/checklist.md': '# Checklist\n',
      },
    }, ctx) as { skill: Record<string, unknown> }

    expect(result.skill).toMatchObject({
      name: 'review-checklist',
      source: 'personal',
      dir: join(home, '.mim', 'skills', 'review-checklist'),
      path: join(home, '.mim', 'skills', 'review-checklist', 'SKILL.md'),
    })
    expect(readFileSync(join(home, '.mim', 'skills', 'review-checklist', 'SKILL.md'), 'utf-8')).toBe(content)
    expect(readFileSync(join(home, '.mim', 'skills', 'review-checklist', 'references', 'checklist.md'), 'utf-8')).toBe('# Checklist\n')
    await expect(tools.call('skill.get', { name: 'review-checklist' }, ctx)).resolves.toMatchObject({
      skill: {
        name: 'review-checklist',
        description: 'Use when reviewing a checklist.',
        body: expect.stringContaining('Follow the checklist.'),
      },
    })
  })

  it('returns revisions and atomically updates a Personal skill', async () => {
    const original = [
      '---',
      'name: email-voice',
      'description: Use when drafting email in my voice.',
      'tools: [gmail.search, gmail.read]',
      'unlocks: [skill.update]',
      '---',
      '',
      '# Email Voice',
      '',
      'Write directly.',
    ].join('\n')
    const created = await tools.call('skill.create', {
      name: 'email-voice',
      content: original,
    }, ctx) as { skill: { revision: string } }

    expect(created.skill.revision).toMatch(/^[a-f0-9]{64}$/)
    await expect(tools.call('skill.get', { name: 'email-voice' }, ctx)).resolves.toMatchObject({
      skill: {
        source: 'personal',
        revision: created.skill.revision,
      },
    })

    const replacement = original.replace('Write directly.', 'Write directly and warmly.')
    const updated = await tools.call('skill.update', {
      name: 'email-voice',
      expectedRevision: created.skill.revision,
      content: replacement,
    }, ctx) as { skill: { revision: string } }

    expect(updated.skill.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(updated.skill.revision).not.toBe(created.skill.revision)
    expect(readFileSync(join(home, '.mim', 'skills', 'email-voice', 'SKILL.md'), 'utf-8')).toBe(replacement)
    await expect(tools.call('skill.get', { name: 'email-voice' }, ctx)).resolves.toMatchObject({
      skill: {
        body: expect.stringContaining('Write directly and warmly.'),
        revision: updated.skill.revision,
      },
    })
  })

  it('rejects stale or invalid Personal skill updates without changing the file', async () => {
    const original = [
      '---',
      'name: email-voice',
      'description: Use when drafting email in my voice.',
      '---',
      '',
      '# Email Voice',
      '',
      'Write directly.',
    ].join('\n')
    const created = await tools.call('skill.create', {
      name: 'email-voice',
      content: original,
    }, ctx) as { skill: { revision: string } }
    const path = join(home, '.mim', 'skills', 'email-voice', 'SKILL.md')
    const externallyChanged = original.replace('Write directly.', 'External edit.')
    writeFileSync(path, externallyChanged, 'utf-8')

    await expect(tools.call('skill.update', {
      name: 'email-voice',
      expectedRevision: created.skill.revision,
      content: original.replace('Write directly.', 'Stale replacement.'),
    }, ctx)).rejects.toThrow('changed since it was opened')
    expect(readFileSync(path, 'utf-8')).toBe(externallyChanged)

    const current = await tools.call('skill.get', { name: 'email-voice' }, ctx) as {
      skill: { revision: string }
    }
    await expect(tools.call('skill.update', {
      name: 'email-voice',
      expectedRevision: current.skill.revision,
      content: externallyChanged.replace('name: email-voice', 'name: somebody-else'),
    }, ctx)).rejects.toThrow('name must match')
    expect(readFileSync(path, 'utf-8')).toBe(externallyChanged)
  })

  it('updates only real Personal skill files', async () => {
    await tools.call('skill.create', {
      name: 'project-voice',
      destination: 'project',
    }, ctx)

    await expect(tools.call('skill.update', {
      name: 'project-voice',
      expectedRevision: 'old',
      content: [
        '---',
        'name: project-voice',
        'description: Project voice.',
        '---',
        '',
        '# Project Voice',
      ].join('\n'),
    }, ctx)).rejects.toThrow('Personal skill not found')

    const outside = join(root, 'outside-email-voice')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), [
      '---',
      'name: linked-voice',
      'description: Linked voice.',
      '---',
      '',
      '# Linked Voice',
    ].join('\n'))
    const personalRoot = join(home, '.mim', 'skills')
    mkdirSync(personalRoot, { recursive: true })
    symlinkSync(outside, join(personalRoot, 'linked-voice'))

    await expect(tools.call('skill.update', {
      name: 'linked-voice',
      expectedRevision: 'old',
      content: [
        '---',
        'name: linked-voice',
        'description: Linked voice.',
        '---',
        '',
        '# Changed',
      ].join('\n'),
    }, ctx)).rejects.toThrow('Symlink')
  })

  it('rejects supplied skill content whose frontmatter name does not match the requested name', async () => {
    await expect(tools.call('skill.create', {
      name: 'expected-name',
      content: [
        '---',
        'name: wrong-name',
        'description: Use when wrong.',
        '---',
        '',
        '# Wrong',
      ].join('\n'),
    }, ctx)).rejects.toThrow('name must match')
  })

  it('rejects unsafe extra file paths for supplied skill content', async () => {
    const content = [
      '---',
      'name: safe-files',
      'description: Use when testing safe files.',
      '---',
      '',
      '# Safe files',
    ].join('\n')

    await expect(tools.call('skill.create', {
      name: 'safe-files',
      content,
      files: { '../escape.md': 'no' },
    }, ctx)).rejects.toThrow(/outside|traversal|relative/i)

    await expect(tools.call('skill.create', {
      name: 'safe-files',
      content,
      files: { '/tmp/escape.md': 'no' },
    }, ctx)).rejects.toThrow(/absolute|relative/i)

    await expect(tools.call('skill.create', {
      name: 'safe-files',
      content,
      files: { 'SKILL.md': 'no' },
    }, ctx)).rejects.toThrow(/SKILL\.md/)

    await expect(tools.call('skill.create', {
      name: 'safe-files',
      content,
      files: { 'references/a.md': 7 },
    }, ctx)).rejects.toThrow(/string/)

    expect(existsSync(join(home, '.mim', 'skills', 'safe-files'))).toBe(false)
  })

  it('returns skill template content with name and description overrides applied', async () => {
    const list = await tools.call('skill.templateList', {}, ctx) as {
      templates: Array<{ id: string; defaultName: string; defaultDescription: string }>
    }
    expect(list.templates.map(template => template.id)).toEqual(['review-checklist', 'house-style', 'r-modelling'])

    const rendered = await tools.call('skill.templateContent', {
      templateId: 'review-checklist',
      name: 'review-checklist-custom',
      description: 'Use when custom review is needed.',
    }, ctx) as { name: string; description: string; content: string }

    expect(rendered).toMatchObject({
      name: 'review-checklist-custom',
      description: 'Use when custom review is needed.',
    })
    expect(rendered.content).toContain('name: review-checklist-custom')
    expect(rendered.content).toContain('description: Use when custom review is needed.')
  })

  it('inspects then imports a skill folder into Personal only after confirmation', async () => {
    const sourceDir = join(root, 'incoming-skill')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'SKILL.md'), [
      '---',
      'name: imported-skill',
      'description: Use when importing.',
      'unlocks: [issues.create]',
      '---',
      '',
      '# Imported',
    ].join('\n'))

    await expect(tools.call('skill.import', { folder: sourceDir }, ctx)).rejects.toThrow('confirmation')

    await expect(tools.call('skill.inspectImport', { folder: sourceDir }, ctx)).resolves.toMatchObject({
      skill: {
        name: 'imported-skill',
        unlocks: ['issues.create'],
      },
      unlocks: ['issues.create'],
    })

    const imported = await tools.call('skill.import', { folder: sourceDir, confirmed: true }, ctx) as { skill: Record<string, unknown> }
    expect(imported.skill).toMatchObject({
      name: 'imported-skill',
      source: 'personal',
      dir: join(home, '.mim', 'skills', 'imported-skill'),
    })
    expect(existsSync(join(home, '.mim', 'skills', 'imported-skill', 'SKILL.md'))).toBe(true)
  })

  it('rejects symlinked import folders', async () => {
    const sourceDir = join(root, 'symlink-skill')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'SKILL.md'), [
      '---',
      'name: symlink-skill',
      'description: Bad import.',
      '---',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'secret.txt'), 'secret')
    symlinkSync(join(root, 'secret.txt'), join(sourceDir, 'secret-link.txt'))

    await expect(tools.call('skill.inspectImport', { folder: sourceDir }, ctx)).rejects.toThrow('Symlink')
  })

  it('excludes app skills from detailed settings listing but allows qualified activation', async () => {
    const pkgDir = join(root, 'package-skills')
    mkdirSync(join(pkgDir, 'review-work'), { recursive: true })
    writeFileSync(join(pkgDir, 'review-work', 'SKILL.md'), [
      '---',
      'name: review-work',
      'description: Use when reviewing.',
      '---',
      '',
      '# Review',
    ].join('\n'))

    const registry = createToolRegistry(createTraceLog())
    registry.setWorkspacePath(workspaceDir)
    registerSkillTools(registry, {
      homeDir: home,
      loader: createSkillLoader({
        builtinDir,
        personalDir: join(home, '.mim', 'skills'),
        getPackageSkillRoots: () => [{ packageId: 'review-app', packageName: 'Review App', dir: pkgDir }],
        getWorkspacePath: () => workspaceDir,
      }),
    })

    const active = await registry.call('skill.list', {}, ctx) as { skills: Array<Record<string, unknown>> }
    const detailed = await registry.call('skill.list', { detailed: true }, ctx) as { skills: Array<Record<string, unknown>> }
    expect(active.skills.map(skill => skill.id)).toContain('package:review-app/review-work')
    expect(detailed.skills.map(skill => skill.id)).not.toContain('package:review-app/review-work')
    await expect(registry.call('skill.get', { name: 'review-work' }, ctx)).resolves.toMatchObject({
      skill: {
        source: 'package',
        packageId: 'review-app',
      },
    })
    await expect(registry.call('skill.get', { name: 'package:review-app/review-work' }, ctx)).resolves.toMatchObject({
      skill: {
        source: 'package',
        packageId: 'review-app',
      },
    })
  })

  it('creates skills in You, Project, and Team destinations with normal editor paths', async () => {
    mkdirSync(join(home, '.mim', 'team'), { recursive: true })
    writeFileSync(join(home, '.mim', 'team', 'team.yaml'), 'name: Shoulders\n')

    const personal = await tools.call('skill.create', { name: 'personal-style' }, ctx) as { skill: Record<string, unknown> }
    const project = await tools.call('skill.create', { name: 'project-review', destination: 'project' }, ctx) as { skill: Record<string, unknown> }
    const team = await tools.call('skill.create', { name: 'team-review', destination: 'team' }, ctx) as { skill: Record<string, unknown> }

    expect(personal.skill).toMatchObject({
      source: 'personal',
      editorPath: '.mim/origins/you/skills/personal-style/SKILL.md',
    })
    expect(project.skill).toMatchObject({
      source: 'project',
      editorPath: 'skills/project-review/SKILL.md',
    })
    expect(team.skill).toMatchObject({
      source: 'team',
      editorPath: '.mim/team/skills/team-review/SKILL.md',
    })
    expect(existsSync(join(home, '.mim', 'team', 'skills', 'team-review', 'SKILL.md'))).toBe(true)
  })

  it('lists instruction origins and creates optional Team instructions on open', async () => {
    mkdirSync(join(home, '.mim', 'team'), { recursive: true })
    writeFileSync(join(home, '.mim', 'team', 'team.yaml'), 'name: Shoulders\n')
    writeFileSync(join(workspaceDir, 'mim.yaml'), 'name: Alpha\n')

    const listed = await tools.call('instruction.list', {}, ctx) as { instructions: Array<Record<string, unknown>> }
    expect(listed.instructions).toEqual([
      expect.objectContaining({ origin: 'personal', label: 'You', writable: true }),
      expect.objectContaining({ origin: 'team', label: 'Shoulders', writable: true }),
      expect.objectContaining({ origin: 'project', label: 'Alpha', writable: true }),
      expect.objectContaining({ origin: 'mim', label: 'Mim', writable: false }),
    ])

    await expect(tools.call('instruction.open', { origin: 'team' }, ctx)).resolves.toMatchObject({
      origin: 'team',
      editorPath: '.mim/team/instructions.md',
    })
    expect(existsSync(join(home, '.mim', 'team', 'instructions.md'))).toBe(true)
  })
})
