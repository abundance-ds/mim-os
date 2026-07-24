import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { createHash, randomBytes } from 'crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { parse as parseYaml } from 'yaml'
import {
  createSkillLoader,
  type PackageSkillRoot,
  type Skill,
  type SkillLoader,
} from '@main/skills.js'
import type { ToolRegistry } from '@main/tools/registry.js'
import {
  loadUserConfig,
  setUserSkillDisabled,
  USER_SKILL_NAME_PATTERN,
} from '@main/userConfig.js'
import { userHomeDir } from '@main/platform.js'
import { listSkillTemplates, renderSkillTemplate } from '@main/templates/skillTemplates.js'
import {
  ensureInstructionEditorDocuments,
  loadInstructionDocuments,
} from '@main/ai/instructions.js'

export interface SkillToolOptions {
  loader?: SkillLoader
  builtinDir?: string
  personalDir?: string
  homeDir?: string
  getPackageSkillRoots?: () => PackageSkillRoot[]
  emit?: (channel: string) => void
}

interface ParsedSkillFolder {
  skill: Skill
  unlocks: string[]
  diagnostics: string[]
}

type SkillDestination = 'personal' | 'project' | 'team'

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required }
}

export function registerSkillTools(tools: ToolRegistry, options: SkillToolOptions = {}): void {
  const home = options.homeDir ?? userHomeDir()
  const personalDir = options.personalDir ?? join(home, '.mim', 'skills')
  const loader = () => options.loader ?? createDefaultLoader(tools, options, home, personalDir)
  const emitChanged = () => options.emit?.('skills:changed')
  const ensureEditorDocuments = () => {
    const workspacePath = tools.getWorkspacePath()
    if (!workspacePath) return
    ensureInstructionEditorDocuments({
      workspacePath,
      homeDir: home,
      builtinSkillsDir: options.builtinDir,
    })
  }

  tools.register({
    name: 'skill.list',
    description: 'List available AI skills as metadata only. Body text is returned by skill.get. Pass detailed=true for Settings metadata including disabled and shadowed authored skills.',
    inputSchema: objectSchema({ detailed: { type: 'boolean' } }),
    execute: async (params) => {
      ensureEditorDocuments()
      const listed = params.detailed === true ? loader().listDetailed() : loader().list()
      return {
        skills: listed.map(skill => decorateSkillOrigin(skill, tools, home)),
        diagnostics: loader().diagnostics(),
      }
    },
  })

  tools.register({
    name: 'skill.get',
    description: 'Activate a skill by name or package-qualified id and return its SKILL.md body plus declared tools.',
    inputSchema: objectSchema({ name: { type: 'string' } }, ['name']),
    execute: async (params) => {
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      if (!name) throw new Error('Missing required parameter: name')
      const skill = loader().get(name)
      if (!skill) throw new Error(`Skill not found: ${name}`)
      const decorated = decorateSkillOrigin(skill, tools, home)
      return {
        skill: skill.source === 'personal'
          ? { ...decorated, revision: skillRevision(readFileSync(skill.path, 'utf-8')) }
          : decorated,
      }
    },
  })

  tools.register({
    name: 'skill.setDisabled',
    description: 'Enable or disable an authored skill globally by writing skills.disabled in ~/.mim/config.yaml.',
    inputSchema: objectSchema({
      name: { type: 'string' },
      disabled: { type: 'boolean' },
    }, ['name', 'disabled']),
    execute: async (params) => {
      const name = requireSkillName(params.name)
      setUserSkillDisabled(name, params.disabled === true, home)
      emitChanged()
      return { name, disabled: params.disabled === true }
    },
  })

  tools.register({
    name: 'skill.create',
    description: 'Create a new skill for You, the current Project, or the connected Team.',
    inputSchema: objectSchema({
      name: { type: 'string' },
      description: { type: 'string' },
      content: { type: 'string' },
      files: { type: 'object' },
      destination: { type: 'string', enum: ['personal', 'project', 'team'] },
    }, ['name']),
    execute: async (params) => {
      const name = requireSkillName(params.name)
      const destination = requireDestination(params.destination)
      const root = destinationRoot(destination, tools, home, personalDir)
      const dir = join(root, name)
      const path = join(dir, 'SKILL.md')
      const extraFiles = validateSkillExtraFiles(params.files, dir)
      const requestedDescription = optionalStringParam(params.description)
      const suppliedContent = optionalStringParam(params.content)
      const parsedContent = suppliedContent
        ? validateSkillCreateContent(suppliedContent, name, requestedDescription)
        : null
      const description = parsedContent?.description
        ?? requestedDescription
        ?? `Use when the user wants help with ${name.replace(/-/g, ' ')}.`
      const content = suppliedContent ?? personalSkillTemplate(name, description)

      if (existsSync(path)) throw new Error(`Skill already exists: ${name}`)
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
        throw new Error(`Symlink paths are not allowed: ${dir}`)
      }
      for (const file of extraFiles) assertNoExistingSymlinkParent(dir, file.path)

      mkdirSync(dir, { recursive: true })
      writeFileSync(path, content, 'utf-8')
      for (const file of extraFiles) {
        assertNoExistingSymlinkParent(dir, file.path)
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.content, 'utf-8')
      }
      emitChanged()
      ensureEditorDocuments()
      return {
        skill: {
          id: name,
          name,
          description,
          source: sourceForDestination(destination),
          dir,
          path,
          editorPath: editorPathForDestination(destination, name),
          revision: skillRevision(content),
        },
      }
    },
  })

  tools.register({
    name: 'skill.update',
    description: 'Replace one Personal SKILL.md if it has not changed since it was read.',
    inputSchema: objectSchema({
      name: { type: 'string' },
      expectedRevision: { type: 'string' },
      content: { type: 'string' },
    }, ['name', 'expectedRevision', 'content']),
    execute: async (params) => {
      const name = requireSkillName(params.name)
      const expectedRevision = requireNonEmptyString(params.expectedRevision, 'expectedRevision')
      const content = requireTextParam(params.content, 'content')
      const dir = join(personalDir, name)
      const path = join(dir, 'SKILL.md')

      if (!existsSync(path)) throw new Error(`Personal skill not found: ${name}`)
      if (lstatSync(dir).isSymbolicLink()) {
        throw new Error(`Symlink paths are not allowed: ${dir}`)
      }
      assertNoExistingSymlinkParent(personalDir, path)
      const pathStat = lstatSync(path)
      if (pathStat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${path}`)
      if (!pathStat.isFile()) throw new Error(`Personal skill SKILL.md is not a file: ${name}`)

      const previous = readFileSync(path, 'utf-8')
      if (skillRevision(previous) !== expectedRevision) {
        throw new Error(`Personal skill changed since it was opened: ${name}`)
      }
      const parsed = validateSkillCreateContent(content, name)

      atomicWriteText(path, content)
      emitChanged()
      ensureEditorDocuments()
      return {
        skill: {
          id: name,
          name,
          description: parsed.description,
          source: 'personal',
          sourceName: 'You',
          dir,
          path,
          editorPath: editorPathForDestination('personal', name),
          revision: skillRevision(content),
        },
      }
    },
  })

  tools.register({
    name: 'skill.templateList',
    description: 'List built-in starter templates for creating authored skills.',
    inputSchema: objectSchema({}),
    execute: async () => listSkillTemplates(),
  })

  tools.register({
    name: 'skill.templateContent',
    description: 'Render a built-in starter skill template without writing files.',
    inputSchema: objectSchema({
      templateId: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
    }, ['templateId']),
    execute: async (params) => {
      const templateId = requireNonEmptyString(params.templateId, 'templateId')
      const name = optionalStringParam(params.name)
      if (name) requireSkillName(name)
      const description = optionalStringParam(params.description)
      return renderSkillTemplate(templateId, { name, description })
    },
  })

  tools.register({
    name: 'skill.inspectImport',
    description: 'Inspect a SKILL.md folder before importing it into You, Project, or Team.',
    inputSchema: objectSchema({
      folder: { type: 'string' },
      destination: { type: 'string', enum: ['personal', 'project', 'team'] },
    }, ['folder']),
    execute: async (params) => {
      const destination = requireDestination(params.destination)
      const root = destinationRoot(destination, tools, home, personalDir)
      const folder = requireAbsoluteFolder(params.folder)
      assertNoSymlinks(folder)
      const inspected = inspectSkillFolder(folder, 'personal', {}, { requireFolderName: false })
      return {
        skill: inspected.skill,
        unlocks: inspected.unlocks,
        diagnostics: inspected.diagnostics,
        destination: join(root, inspected.skill.name),
        collision: existsSync(join(root, inspected.skill.name, 'SKILL.md')),
      }
    },
  })

  tools.register({
    name: 'skill.import',
    description: 'Import an inspected skill folder into You, Project, or Team. Requires confirmed=true.',
    inputSchema: objectSchema({
      folder: { type: 'string' },
      confirmed: { type: 'boolean' },
      destination: { type: 'string', enum: ['personal', 'project', 'team'] },
    }, ['folder']),
    execute: async (params) => {
      if (params.confirmed !== true) throw new Error('Import requires confirmation after inspection')
      const destinationKind = requireDestination(params.destination)
      const root = destinationRoot(destinationKind, tools, home, personalDir)
      const folder = requireAbsoluteFolder(params.folder)
      assertNoSymlinks(folder)
      const inspected = inspectSkillFolder(folder, 'personal', {}, { requireFolderName: false })
      const destination = join(root, inspected.skill.name)
      if (existsSync(destination)) throw new Error(`Skill already exists: ${inspected.skill.name}`)
      copyTreeNoSymlinks(folder, destination)
      emitChanged()
      const imported = loader().get(inspected.skill.name)
      return {
        skill: imported ? metadataOnly(imported) : {
          ...metadataOnly(inspected.skill),
          source: sourceForDestination(destinationKind),
          dir: destination,
          path: join(destination, 'SKILL.md'),
          editorPath: editorPathForDestination(destinationKind, inspected.skill.name),
        },
        unlocks: inspected.unlocks,
        diagnostics: inspected.diagnostics,
      }
    },
  })

  tools.register({
    name: 'skill.delete',
    description: 'Delete a writable skill from You, Project, or Team.',
    inputSchema: objectSchema({
      name: { type: 'string' },
      destination: { type: 'string', enum: ['personal', 'project', 'team'] },
    }, ['name']),
    execute: async (params) => {
      const name = requireSkillName(params.name)
      const destination = requireDestination(params.destination)
      const dir = join(destinationRoot(destination, tools, home, personalDir), name)
      if (!existsSync(dir)) throw new Error(`Skill not found: ${name}`)
      rmSync(dir, { recursive: true, force: true })
      emitChanged()
      return { deleted: name }
    },
  })

  tools.register({
    name: 'instruction.list',
    description: 'List composed instruction origins and their editor paths.',
    inputSchema: objectSchema({}),
    execute: async () => {
      const workspacePath = tools.getWorkspacePath()
      if (!workspacePath) throw new Error('No workspace open')
      ensureEditorDocuments()
      return {
        instructions: instructionList(workspacePath, home),
      }
    },
  })

  tools.register({
    name: 'instruction.open',
    description: 'Ensure and return the normal editor path for one instruction origin.',
    inputSchema: objectSchema({
      origin: { type: 'string', enum: ['mim', 'team', 'personal', 'project'] },
    }, ['origin']),
    execute: async (params) => {
      const workspacePath = tools.getWorkspacePath()
      if (!workspacePath) throw new Error('No workspace open')
      const origin = requireInstructionOrigin(params.origin)
      ensureEditorDocuments()
      ensureOptionalInstruction(origin, workspacePath, home)
      const item = instructionList(workspacePath, home).find(entry => entry.origin === origin)
      if (!item) throw new Error(`Instruction origin is unavailable: ${origin}`)
      return item
    },
  })
}

function createDefaultLoader(
  tools: ToolRegistry,
  options: SkillToolOptions,
  home: string,
  personalDir: string,
): SkillLoader {
  const currentTeamName = teamName(home)
  return createSkillLoader({
    builtinDir: options.builtinDir,
    personalDir,
    teamDir: currentTeamName ? join(home, '.mim', 'team', 'skills') : undefined,
    teamName: currentTeamName ?? undefined,
    getWorkspacePath: () => tools.getWorkspacePath(),
    getPackageSkillRoots: options.getPackageSkillRoots,
    getDisabledSkillNames: () => new Set(loadUserConfig(home).skills.disabled),
  })
}

function destinationRoot(
  destination: SkillDestination,
  tools: ToolRegistry,
  home: string,
  personalDir: string,
): string {
  if (destination === 'personal') return personalDir
  const workspace = tools.getWorkspacePath()
  if (!workspace) throw new Error('No workspace open')
  if (destination === 'project') return join(workspace, 'skills')
  const name = teamName(home)
  if (!name) throw new Error('No Team source connected')
  return join(home, '.mim', 'team', 'skills')
}

function decorateSkillOrigin<T extends { source: string; sourceName?: string }>(
  skill: T,
  tools: ToolRegistry,
  home: string,
): T {
  let sourceName = skill.sourceName
  if (skill.source === 'personal') sourceName = 'You'
  else if (skill.source === 'project') sourceName = projectName(tools.getWorkspacePath() ?? '') ?? 'Project'
  else if (skill.source === 'team') sourceName = sourceName || teamName(home) || 'Team'
  else if (skill.source === 'mim') sourceName = 'Mim'
  return { ...skill, ...(sourceName ? { sourceName } : {}) }
}

function requireDestination(value: unknown): SkillDestination {
  if (value === undefined || value === '') return 'personal'
  if (value === 'personal' || value === 'project' || value === 'team') return value
  throw new Error(`Invalid skill destination: ${String(value)}`)
}

function sourceForDestination(destination: SkillDestination): 'personal' | 'project' | 'team' {
  return destination
}

function editorPathForDestination(destination: SkillDestination, name: string): string {
  if (destination === 'personal') return `.mim/origins/you/skills/${name}/SKILL.md`
  if (destination === 'team') return `.mim/team/skills/${name}/SKILL.md`
  return `skills/${name}/SKILL.md`
}

function instructionList(workspacePath: string, home: string): Array<Record<string, unknown>> {
  const byOrigin = new Map(
    loadInstructionDocuments({ workspacePath, homeDir: home })
      .map(doc => [doc.origin, {
        origin: doc.origin,
        label: doc.label,
        editorPath: doc.editorPath,
        writable: doc.writable,
      }]),
  )
  const team = teamName(home)
  if (team && !byOrigin.has('team')) {
    byOrigin.set('team', {
      origin: 'team',
      label: team,
      editorPath: '.mim/team/instructions.md',
      writable: true,
    })
  }
  if (!byOrigin.has('project')) {
    byOrigin.set('project', {
      origin: 'project',
      label: projectName(workspacePath) ?? 'Project',
      editorPath: 'AGENTS.md',
      writable: true,
    })
  }
  return (['personal', 'team', 'project', 'mim'] as const)
    .flatMap(origin => byOrigin.get(origin) ?? [])
}

function ensureOptionalInstruction(
  origin: 'mim' | 'team' | 'personal' | 'project',
  workspacePath: string,
  home: string,
): void {
  if (origin === 'mim' || origin === 'personal') return
  const path = origin === 'team'
    ? join(home, '.mim', 'team', 'instructions.md')
    : join(workspacePath, 'AGENTS.md')
  if (origin === 'team' && !teamName(home)) throw new Error('No Team source connected')
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    origin === 'team'
      ? '# Team Instructions\n\nAdd guidance that applies across Team Projects.\n'
      : '# Project Instructions\n\nAdd guidance specific to this Project.\n',
    'utf-8',
  )
}

function requireInstructionOrigin(value: unknown): 'mim' | 'team' | 'personal' | 'project' {
  if (value === 'mim' || value === 'team' || value === 'personal' || value === 'project') return value
  throw new Error(`Invalid instruction origin: ${String(value)}`)
}

function teamName(home: string): string | null {
  return yamlName(join(home, '.mim', 'team', 'team.yaml'))
}

function projectName(workspace: string): string | null {
  return yamlName(join(workspace, 'mim.yaml'))
}

function yamlName(path: string): string | null {
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as { name?: unknown }
    return typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null
  } catch {
    return null
  }
}

function inspectSkillFolder(
  folder: string,
  source: 'personal',
  _extra: Record<string, never> = {},
  options: { requireFolderName?: boolean } = {},
): ParsedSkillFolder {
  const skillMd = join(folder, 'SKILL.md')
  if (!existsSync(skillMd) || !statSync(skillMd).isFile()) {
    throw new Error(`Missing SKILL.md: ${folder}`)
  }
  const raw = readFileSync(skillMd, 'utf-8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter')

  const diagnostics: string[] = []
  let frontmatter: unknown
  try {
    frontmatter = parseYaml(match[1])
  } catch (err) {
    throw new Error(`Invalid YAML frontmatter: ${(err as Error).message}`)
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('SKILL.md frontmatter must be an object')
  }

  const meta = frontmatter as Record<string, unknown>
  const expectedName = basename(folder)
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (!USER_SKILL_NAME_PATTERN.test(name)) throw new Error(`Invalid skill name: ${name || String(meta.name)}`)
  if (options.requireFolderName !== false && name !== expectedName) throw new Error('Skill name must match folder name')
  if (!description) throw new Error('Skill frontmatter requires description')

  const tools = stringArray(meta.tools)
  const unlocks = stringArray(meta.unlocks)
  const skill: Skill = {
    id: name,
    name,
    description,
    tools,
    unlocks,
    source,
    dir: folder,
    path: skillMd,
    diagnostics: [],
    body: match[2].trim(),
  }
  return { skill, unlocks, diagnostics }
}

function metadataOnly({ body: _body, ...metadata }: Skill): SkillMetadata {
  void _body
  return metadata
}

function requireSkillName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!USER_SKILL_NAME_PATTERN.test(name)) throw new Error(`Invalid skill name: ${name || String(value)}`)
  return name
}

function requireNonEmptyString(value: unknown, key: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`Missing required parameter: ${key}`)
  return text
}

function requireTextParam(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required parameter: ${key}`)
  return value
}

function optionalStringParam(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Parameter must be a string')
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function validateSkillCreateContent(
  content: string,
  expectedName: string,
  expectedDescription?: string,
): { description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) throw new Error('SKILL.md content must start with YAML frontmatter')

  let frontmatter: unknown
  try {
    frontmatter = parseYaml(match[1])
  } catch (err) {
    throw new Error(`Invalid YAML frontmatter: ${(err as Error).message}`)
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('SKILL.md frontmatter must be an object')
  }

  const meta = frontmatter as Record<string, unknown>
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (name !== expectedName) throw new Error('Skill content frontmatter name must match requested name')
  if (!description) throw new Error('Skill content frontmatter requires description')
  if (expectedDescription && description !== expectedDescription) {
    throw new Error('Skill content frontmatter description must match requested description')
  }
  return { description }
}

function validateSkillExtraFiles(value: unknown, skillDir: string): Array<{ path: string; content: string }> {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Parameter files must be an object')
  }

  const files: Array<{ path: string; content: string }> = []
  for (const [rawPath, content] of Object.entries(value as Record<string, unknown>)) {
    if (typeof content !== 'string') throw new Error(`Skill extra file ${rawPath} content must be a string`)
    const normalized = rawPath.trim().replace(/\\/g, '/')
    if (!normalized) throw new Error('Skill extra file paths must be non-empty relative paths')
    if (isAbsolute(normalized)) throw new Error(`Skill extra file path must be relative: ${rawPath}`)
    const parts = normalized.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) {
      throw new Error(`Skill extra file path contains traversal: ${rawPath}`)
    }
    if (parts.some(part => part === '.git')) {
      throw new Error(`Skill extra file path cannot include .git: ${rawPath}`)
    }
    if (parts.some(part => part.toLowerCase() === 'skill.md')) {
      throw new Error('Skill extra files cannot replace SKILL.md')
    }

    const target = resolve(skillDir, ...parts)
    const rel = relative(skillDir, target)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Skill extra file path escapes skill directory: ${rawPath}`)
    }
    files.push({ path: target, content })
  }
  return files
}

function assertNoExistingSymlinkParent(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes skill directory: ${target}`)
  }
  let current = root
  if (existsSync(current)) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${current}`)
    if (!stat.isDirectory()) throw new Error(`Skill path is not a directory: ${current}`)
  }
  for (const part of rel.split(/[\\/]/).slice(0, -1)) {
    if (!part) continue
    current = join(current, part)
    if (!existsSync(current)) continue
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${current}`)
    if (!stat.isDirectory()) throw new Error(`Skill parent path is not a directory: ${current}`)
  }
}

function requireAbsoluteFolder(value: unknown): string {
  const folder = typeof value === 'string' ? value.trim() : ''
  if (!folder) throw new Error('Missing required folder path')
  if (!isAbsolute(folder)) throw new Error(`Folder path must be absolute: ${folder}`)
  const resolved = resolve(folder)
  const stat = lstatSync(resolved)
  if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${folder}`)
  if (!stat.isDirectory()) throw new Error(`Folder is not a directory: ${folder}`)
  return resolved
}

function assertNoSymlinks(root: string): void {
  const current = lstatSync(root)
  if (current.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${root}`)
  if (!current.isDirectory()) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = join(root, entry.name)
    const stat = lstatSync(child)
    if (stat.isSymbolicLink()) throw new Error(`Symlink entries are not allowed: ${child}`)
    if (stat.isDirectory()) assertNoSymlinks(child)
  }
}

function copyTreeNoSymlinks(source: string, destination: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`Symlink entries are not allowed: ${source}`)
  if (stat.isDirectory()) {
    if (basename(source) === '.git') return
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copyTreeNoSymlinks(join(source, entry.name), join(destination, entry.name))
    }
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []
}

function personalSkillTemplate(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    'tools: []',
    'unlocks: []',
    '---',
    '',
    `# ${titleFromName(name)}`,
    '',
    '## When to use',
    '',
    '- Use this skill when the request matches the description above.',
    '',
    '## Instructions',
    '',
    '- Add concise, operational guidance for the assistant.',
    '',
  ].join('\n')
}

function titleFromName(name: string): string {
  return name.split('-')
    .filter(Boolean)
    .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function skillRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function atomicWriteText(path: string, content: string): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* tmp may not exist */ }
    throw err
  }
}
