import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  loadUserConfig,
  resolveModelDefault,
  reset,
  setUserSkillDisabled,
  setPersonalSetting,
  setTeamConnection,
} from '@main/userConfig.js'

function writeConfig(home: string, text: string): void {
  mkdirSync(join(home, '.mim'), { recursive: true })
  writeFileSync(join(home, '.mim', 'config.yaml'), text)
}

describe('userConfig — loadUserConfig', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mim-home-'))
    reset()
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    reset()
  })

  it('parses a full config.yaml into the typed UserConfig', () => {
    writeConfig(home, [
      'user:',
      '  name: Paul',
      '  email: user@example.com',
      '  timezone: Europe/Berlin',
      'defaults:',
      '  google: acme.com',
      '  slack: T123',
      '  models:',
      '    chat: claude-sonnet-4-6',
      '    inline: gpt-5.4',
      '    ghost: claude-haiku-4-5-20251001',
      'preferences:',
      '  theme: sage',
      '  editorFontSize: 18',
      '  automationApprovalMode: strict',
      'team:',
      '  repository: git@github.com:example-org/team.git',
      '',
    ].join('\n'))

    const config = loadUserConfig(home)
    expect(config.user.name).toBe('Paul')
    expect(config.user.email).toBe('user@example.com')
    expect(config.user.timezone).toBe('Europe/Berlin')
    expect(config.defaults.google).toBe('acme.com')
    expect(config.defaults.slack).toBe('T123')
    expect(config.defaults.models.chat).toBe('claude-sonnet-4-6')
    expect(config.defaults.models.inline).toBe('gpt-5.4')
    expect(config.defaults.models.ghost).toBe('claude-haiku-4-5-20251001')
    expect(config.preferences.theme).toBe('sage')
    expect(config.preferences.editorFontSize).toBe(18)
    expect(config.preferences.automationApprovalMode).toBe('strict')
    expect(config.team).toEqual({ repository: 'git@github.com:example-org/team.git' })
  })

  it('writes Personal settings without disturbing identity, skill toggles, or model defaults', () => {
    writeConfig(home, [
      'user:',
      '  name: Paul',
      'defaults:',
      '  models:',
      '    chat: claude-sonnet-4-6',
      'skills:',
      '  disabled:',
      '    - email-voice',
      '',
    ].join('\n'))

    setPersonalSetting('theme', 'nord', home)
    setPersonalSetting('lastInlineModel', 'gpt-5.4', home)
    setPersonalSetting('editorLivePreview', false, home)

    const config = loadUserConfig(home)
    expect(config.user.name).toBe('Paul')
    expect(config.defaults.models.chat).toBe('claude-sonnet-4-6')
    expect(config.defaults.models.inline).toBe('gpt-5.4')
    expect(config.preferences.theme).toBe('nord')
    expect(config.preferences.editorLivePreview).toBe(false)
    expect(config.skills.disabled).toEqual(['email-voice'])
  })

  it('writes the one Team connection without disturbing other Personal config', () => {
    writeConfig(home, [
      'user:',
      '  name: Paul',
      'preferences:',
      '  theme: nord',
      '',
    ].join('\n'))

    setTeamConnection({ repository: 'git@github.com:example-org/team.git' }, home)

    const config = loadUserConfig(home)
    expect(config.team).toEqual({ repository: 'git@github.com:example-org/team.git' })
    expect(config.user.name).toBe('Paul')
    expect(config.preferences.theme).toBe('nord')
  })

  it('missing file → safe empty defaults, no throw', () => {
    const config = loadUserConfig(home)
    expect(config.user).toEqual({})
    expect(config.defaults.models).toEqual({})
  })

  it('malformed YAML → safe empty defaults, no throw', () => {
    writeConfig(home, 'user: [unclosed\n  : : :')
    let config!: ReturnType<typeof loadUserConfig>
    expect(() => { config = loadUserConfig(home) }).not.toThrow()
    expect(config.defaults.models).toEqual({})
  })

  it('partial config (only user, no defaults) tolerated', () => {
    writeConfig(home, 'user:\n  name: Solo\n')
    const config = loadUserConfig(home)
    expect(config.user.name).toBe('Solo')
    expect(config.defaults.models).toEqual({})
  })

  it('never surfaces an api-key-like field present in config.yaml', () => {
    writeConfig(home, [
      'user:',
      '  name: Paul',
      'ANTHROPIC_API_KEY: sk-should-not-leak',
      'defaults:',
      '  apiKey: sk-also-leaks',
      '  models:',
      '    chat: claude-sonnet-4-6',
      '',
    ].join('\n'))

    const config = loadUserConfig(home)
    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain('sk-should-not-leak')
    expect(serialized).not.toContain('sk-also-leaks')
    expect((config.defaults as Record<string, unknown>).apiKey).toBeUndefined()
  })

  it('never surfaces credentials embedded in a manually edited Team repository URL', () => {
    writeConfig(home, [
      'team:',
      '  repository: https://person:secret-token@example.com/team.git',
      '',
    ].join('\n'))

    const config = loadUserConfig(home)
    expect(config.team).toBeUndefined()
    expect(JSON.stringify(config)).not.toContain('secret-token')
  })

  it('ignores retired connector policy fields', () => {
    writeConfig(home, [
      'connectors:',
      '  slack:',
      '    aiEnabled: true',
      '    sendEnabled: false',
      '    privateChannels: false',
      '    directMessages: true',
      '  google:',
      '    aiEnabled: true',
      '    gmailEnabled: true',
      '    gmailSendEnabled: false',
      '    calendarEnabled: true',
      '    calendarWriteEnabled: false',
      '    driveEnabled: true',
      '    sheetsWriteEnabled: false',
    ].join('\n'))
    const config = loadUserConfig(home)
    expect(config).not.toHaveProperty('connectors')
  })
})

describe('userConfig — resolveModelDefault', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mim-home-'))
    reset()
    process.env.HOME = home
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    reset()
  })

  it('workspace override wins over config.yaml', () => {
    writeConfig(home, 'defaults:\n  models:\n    chat: claude-sonnet-4-6\n')
    reset()
    expect(resolveModelDefault('chat', { override: 'gpt-5.4' })).toBe('gpt-5.4')
  })

  it('config.yaml wins when no override', () => {
    writeConfig(home, 'defaults:\n  models:\n    chat: claude-sonnet-4-6\n    ghost: claude-haiku-4-5-20251001\n')
    reset()
    expect(resolveModelDefault('chat', {})).toBe('claude-sonnet-4-6')
    expect(resolveModelDefault('ghost', {})).toBe('claude-haiku-4-5-20251001')
  })

  it('undefined when neither override nor config set', () => {
    expect(resolveModelDefault('chat', {})).toBeUndefined()
  })

  it('reset() clears the in-process cache between cases', () => {
    writeConfig(home, 'defaults:\n  models:\n    chat: claude-sonnet-4-6\n')
    reset()
    expect(resolveModelDefault('chat', {})).toBe('claude-sonnet-4-6')

    writeConfig(home, 'defaults:\n  models:\n    chat: gpt-5.4\n')
    reset()
    expect(resolveModelDefault('chat', {})).toBe('gpt-5.4')
  })
})

describe('userConfig — skill config', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mim-home-'))
    reset()
    process.env.HOME = home
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    reset()
  })

  it('ignores retired skill sources and parses globally disabled authored skills', () => {
    writeConfig(home, [
      'skillSources:',
      '  acme-research:',
      '    name: Acme Research',
      '    git: https://github.com/acme/mim-skills.git',
      '    trusted: true',
      '  local-team:',
      '    path: /Users/test/team-skills',
      'skills:',
      '  disabled:',
      '    - issue-work',
      '    - docx-review',
      '',
    ].join('\n'))

    const config = loadUserConfig(home)

    expect(config).not.toHaveProperty('skillSources')
    expect(config.skills.disabled).toEqual(['docx-review', 'issue-work'])
  })

  it('writes global disabled skills without clobbering unrelated config', () => {
    writeConfig(home, [
      'user:',
      '  name: Paul',
      'defaults:',
      '  models:',
      '    chat: claude-sonnet-4-6',
      '',
    ].join('\n'))

    setUserSkillDisabled('issue-work', true, home)
    setUserSkillDisabled('docx-review', true, home)
    setUserSkillDisabled('issue-work', false, home)

    const config = loadUserConfig(home)
    expect(config.user.name).toBe('Paul')
    expect(config.defaults.models.chat).toBe('claude-sonnet-4-6')
    expect(config.skills.disabled).toEqual(['docx-review'])
    expect(readFileSync(join(home, '.mim', 'config.yaml'), 'utf-8')).toContain('user:')
  })

})
