import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  MIM_INSTRUCTIONS,
  composeInstructions,
  ensureInstructionEditorDocuments,
  loadInstructionDocuments,
} from '@main/ai/instructions.js'

describe('instruction origins', () => {
  let root: string
  let home: string
  let workspace: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mim-instructions-'))
    home = join(root, 'home')
    workspace = join(root, 'project')
    mkdirSync(join(home, '.mim', 'team'), { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(home, '.mim', 'team', 'team.yaml'), 'name: Acme Research\n')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('loads Mim, Team, Personal, and Project from least to most specific', () => {
    writeFileSync(join(home, '.mim', 'team', 'instructions.md'), 'TEAM RULE')
    writeFileSync(join(home, '.mim', 'instructions.md'), 'PERSONAL RULE')
    writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT RULE')

    const docs = loadInstructionDocuments({ workspacePath: workspace, homeDir: home })

    expect(docs.map(doc => doc.origin)).toEqual(['mim', 'team', 'personal', 'project'])
    expect(docs.map(doc => doc.label)).toEqual(['Mim', 'Acme Research', 'You', 'Project'])
    expect(composeInstructions(docs)).toMatch(
      /MIM INSTRUCTIONS[\s\S]*TEAM INSTRUCTIONS — Acme Research[\s\S]*PERSONAL INSTRUCTIONS — You[\s\S]*PROJECT INSTRUCTIONS — Project/,
    )
  })

  it('keeps optional absent documents out of prompt composition', () => {
    const docs = loadInstructionDocuments({ workspacePath: workspace, homeDir: home })
    expect(docs.map(doc => doc.origin)).toEqual(['mim'])
    expect(docs[0].content).toBe(MIM_INSTRUCTIONS)
  })

  it('creates managed editor documents without copying writable sources', () => {
    const builtinSkills = join(root, 'builtin-skills')
    mkdirSync(builtinSkills, { recursive: true })
    const result = ensureInstructionEditorDocuments({
      workspacePath: workspace,
      homeDir: home,
      builtinSkillsDir: builtinSkills,
    })

    expect(result.personalInstructions).toBe('.mim/origins/you/instructions.md')
    expect(result.mimInstructions).toBe('.mim/origins/mim/instructions.md')
    expect(result.personalSkills).toBe('.mim/origins/you/skills')
    expect(result.mimSkills).toBe('.mim/origins/mim/skills')
    expect(lstatSync(join(workspace, result.personalInstructions)).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(workspace, result.personalSkills)).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(workspace, result.mimSkills)).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(workspace, result.mimInstructions), 'utf-8')).toBe(MIM_INSTRUCTIONS)
    expect(existsSync(join(home, '.mim', 'instructions.md'))).toBe(true)
  })
})
