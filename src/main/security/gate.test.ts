import { describe, expect, it, vi } from 'vitest'
import {
  PermissionDeniedError,
  buildApprovalPreview,
  createPermissionGate,
  getToolPolicy,
  redactPermissionParams,
  traceGateDecision,
  toolEffect,
  type PermissionApprovalRequest,
  type PermissionDecisionEvent,
  type ToolPolicy,
} from '@main/security/gate.js'
import type { PackagePermissions } from '@main/packages/packageManifest.js'
import type { ToolDef } from '@main/tools/registry.js'
import type { TraceLog } from '@main/trace/trace.js'

function tool(name: string): ToolDef {
  return {
    name,
    description: name,
    execute: async () => ({ ok: true }),
  }
}

function makeGate(options: {
  mode?: 'normal' | 'strict' | 'developer'
  workspacePath?: string | null
  packagePermissions?: PackagePermissions
  requests?: PermissionApprovalRequest[]
  decisions?: PermissionDecisionEvent[]
  getDynamicToolPolicy?: (toolName: string) => ToolPolicy | undefined
  resolveSavedBrowserSessionGrant?: Parameters<typeof createPermissionGate>[0]['resolveSavedBrowserSessionGrant']
  grantSavedBrowserSessionDomain?: Parameters<typeof createPermissionGate>[0]['grantSavedBrowserSessionDomain']
} = {}) {
  const requests = options.requests ?? []
  const decisions = options.decisions ?? []
  const gate = createPermissionGate({
    getApprovalMode: () => options.mode ?? 'normal',
    getWorkspacePath: () => options.workspacePath ?? '/Users/test/workspace',
    getPackagePermissions: options.packagePermissions
      ? () => options.packagePermissions
      : undefined,
    getDynamicToolPolicy: options.getDynamicToolPolicy,
    resolveSavedBrowserSessionGrant: options.resolveSavedBrowserSessionGrant,
    grantSavedBrowserSessionDomain: options.grantSavedBrowserSessionDomain,
    sendApprovalRequest: (request) => {
      requests.push(request)
      return true
    },
    recordDecision: (event) => {
      decisions.push(event)
    },
  })
  return { gate, requests, decisions }
}

describe('tool policy metadata', () => {
  it('classifies the tools that can mutate files or run commands', () => {
    expect(getToolPolicy('fs.read')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('fs.readImageDataUrl')).toMatchObject({ category: 'read', risk: 'low', pathParam: 'path' })
    expect(getToolPolicy('fs.write')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'path' })
    expect(getToolPolicy('fs.writeBytes')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'path' })
    expect(getToolPolicy('fs.edit')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'path' })
    expect(getToolPolicy('comments.list')).toMatchObject({ category: 'read', risk: 'low', pathParam: 'path' })
    expect(getToolPolicy('comments.add')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'path' })
    expect(getToolPolicy('comments.reply')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'path' })
    expect(getToolPolicy('comments.resolve')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'path' })
    expect(getToolPolicy('fs.rename')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'old_path' })
    expect(getToolPolicy('fs.delete')).toMatchObject({ category: 'write', risk: 'high', pathParam: 'path' })
    expect(getToolPolicy('terminal.run')).toMatchObject({ category: 'system', risk: 'high', targetParam: 'command' })
    expect(getToolPolicy('package.delete')).toMatchObject({ category: 'write', risk: 'high' })
    expect(getToolPolicy('package.readme')).toMatchObject({ category: 'read', risk: 'low', targetParam: 'id' })
    expect(getToolPolicy('routine.update')).toMatchObject({ category: 'write', risk: 'medium', targetParam: 'name' })
    expect(getToolPolicy('routine.enable')).toMatchObject({ category: 'settings', risk: 'medium', targetParam: 'name' })
    expect(getToolPolicy('routine.remove')).toMatchObject({ category: 'write', risk: 'high', targetParam: 'name' })
    expect(getToolPolicy('routine.start')).toMatchObject({ category: 'general', risk: 'medium', targetParam: 'name' })
    expect(getToolPolicy('workbench.openArtifact')).toMatchObject({ category: 'ui', risk: 'low', targetParam: 'packageId' })
    expect(getToolPolicy('slack.search')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'query' })
    expect(getToolPolicy('slack.send')).toMatchObject({ category: 'network', risk: 'high', targetParam: 'channel' })
    expect(getToolPolicy('slack.setToken')).toMatchObject({ category: 'secrets', risk: 'high', targetParam: 'account' })
    expect(getToolPolicy('slack.bot.connect')).toMatchObject({ category: 'secrets', risk: 'high', targetParam: 'account' })
    expect(getToolPolicy('slack.bot.setup')).toMatchObject({ category: 'secrets', risk: 'high', targetParam: 'channel' })
    expect(getToolPolicy('slack.listener.status')).toMatchObject({ category: 'network', risk: 'low', targetParam: 'account' })
    expect(getToolPolicy('gmail.search')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'query' })
    expect(getToolPolicy('gmail.send')).toMatchObject({ category: 'network', risk: 'high', targetParam: 'to' })
    expect(getToolPolicy('calendar.events')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'calendarId' })
    expect(getToolPolicy('calendar.create')).toMatchObject({ category: 'network', risk: 'high', targetParam: 'summary' })
    expect(getToolPolicy('drive.search')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'query' })
    expect(getToolPolicy('docs.read')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'fileId' })
    expect(getToolPolicy('sheets.read')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'spreadsheetId' })
    expect(getToolPolicy('web.read')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'url' })
    expect(getToolPolicy('web.live.open')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'url' })
    expect(getToolPolicy('web.live.act')).toMatchObject({ category: 'network', risk: 'medium', targetParam: 'action' })
    expect(getToolPolicy('google.exchangeCode')).toMatchObject({ category: 'secrets', risk: 'high', targetParam: 'account' })
    expect(getToolPolicy('documents.importMarkdown')).toMatchObject({ category: 'write', risk: 'medium', pathParam: 'output_path' })
    expect(getToolPolicy('documents.importMarkdown.formats')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('documents.pdf.extract')).toMatchObject({ category: 'read', risk: 'low', pathParam: 'path' })
    expect(getToolPolicy('documents.pickImportFile')).toMatchObject({ category: 'write', risk: 'low' })
    expect(getToolPolicy('references.setBibliographyPath')).toMatchObject({ category: 'settings', risk: 'medium', pathParam: 'path' })
    expect(getToolPolicy('telemetry.status')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('telemetry.track')).toMatchObject({ category: 'ui', risk: 'low' })
    expect(getToolPolicy('telemetry.setEnabled')).toMatchObject({ category: 'settings', risk: 'medium' })
  })

  it('classifies app secret tools as secrets-category mutations', () => {
    expect(getToolPolicy('package.secrets.set')).toMatchObject({ category: 'secrets', risk: 'high', targetParam: 'name' })
    expect(getToolPolicy('package.secrets.delete')).toMatchObject({ category: 'secrets', risk: 'high', targetParam: 'name' })
    expect(getToolPolicy('package.secrets.status')).toMatchObject({ category: 'read', risk: 'low' })
  })

  it('treats unknown tools as low risk but still records their real name', () => {
    expect(getToolPolicy('custom.inspect')).toEqual({
      category: 'general',
      risk: 'low',
      label: 'custom.inspect',
    })
  })
})

describe('tool effect classification', () => {
  it('classifies by what the tool does, independent of its risk tier', () => {
    // reads — local, no side effects
    expect(toolEffect('fs.read')).toBe('read')
    expect(toolEffect('package.readme')).toBe('read')
    expect(toolEffect('search')).toBe('read')
    expect(toolEffect('ai.generateObject')).toBe('read')
    // navigation / status are reads even though their bucket is mutating
    expect(toolEffect('editor.open')).toBe('read')
    expect(toolEffect('workbench.openArtifact')).toBe('read')
    expect(toolEffect('settings.get')).toBe('read')
    expect(toolEffect('toolPolicy.get')).toBe('read')
    expect(toolEffect('telemetry.track')).toBe('read')
    expect(toolEffect('slack.status')).toBe('read')
    expect(toolEffect('slack.bot.status')).toBe('read')
    expect(toolEffect('slack.bot.check')).toBe('read')
    expect(toolEffect('slack.listener.status')).toBe('read')
    // benign internal writes exempted from Normal (still caught by Strict)
    expect(toolEffect('workspace.orient')).toBe('read')
    expect(toolEffect('log.append')).toBe('read')
    // mutations — change data or state
    expect(toolEffect('fs.write')).toBe('mutate')
    expect(toolEffect('fs.writeBytes')).toBe('mutate')
    expect(toolEffect('comments.add')).toBe('mutate')
    expect(toolEffect('comments.resolve')).toBe('mutate')
    expect(toolEffect('fs.delete')).toBe('mutate')
    expect(toolEffect('terminal.run')).toBe('mutate')
    expect(toolEffect('settings.set')).toBe('mutate')
    expect(toolEffect('toolPolicy.set')).toBe('mutate')
    expect(toolEffect('references.setBibliographyPath')).toBe('mutate')
    expect(toolEffect('session.delete')).toBe('mutate')
    expect(toolEffect('app.enable')).toBe('mutate')
    // external — third-party services
    expect(toolEffect('slack.history')).toBe('external')
    expect(toolEffect('gmail.send')).toBe('external')
    expect(toolEffect('docs.read')).toBe('external')
    // unknown tools default to mutate (safe)
    expect(toolEffect('custom.unknown')).toBe('mutate')
  })
})

describe('permission gate decisions', () => {
  it('allows direct user calls without prompting', async () => {
    const { gate, requests, decisions } = makeGate()

    await gate.check(tool('fs.delete'), { path: 'old.md' }, { actor: 'user' })

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      actor: 'user',
      tool: 'fs.delete',
      reason: 'direct user action',
    })
  })

  it('allows ordinary workspace reads by AI in normal mode', async () => {
    const { gate, requests, decisions } = makeGate()

    await gate.check(tool('fs.read'), { path: 'docs/notes.md' }, { actor: 'ai', sessionId: 's1' })

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      actor: 'ai',
      tool: 'fs.read',
      pathKind: 'workspace',
    })
  })

  it('asks before high-risk AI calls and waits for approval', async () => {
    const { gate, requests, decisions } = makeGate()
    const pending = gate.check(tool('terminal.run'), { command: 'npm test' }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'terminal.run',
      actor: 'ai',
      sessionId: 's1',
      risk: 'high',
      target: 'npm test',
      reason: 'This changes your workspace',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await expect(pending).resolves.toBeUndefined()
    expect(decisions.map(event => event.decision)).toContain('requested')
    expect(decisions.at(-1)).toMatchObject({ decision: 'approved', tool: 'terminal.run' })
  })

  it('asks before sensitive workspace paths even for low-risk tools', async () => {
    const { gate, requests } = makeGate()
    const pending = gate.check(tool('fs.read'), { path: '.env' }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'fs.read',
      pathKind: 'sensitive',
      reason: 'Path contains sensitive segment: .env',
    })

    gate.respond(requests[0].requestId, { approved: false })
    await expect(pending).rejects.toThrow(PermissionDeniedError)
  })

  it('asks before outside-workspace paths', async () => {
    const { gate, requests } = makeGate()
    const pending = gate.check(
      tool('workspace.open'),
      { path: '/Users/test/Downloads/client-work' },
      { actor: 'ai', sessionId: 's1' },
    )

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'workspace.open',
      pathKind: 'outside-workspace',
      target: '/Users/test/Downloads/client-work',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await expect(pending).resolves.toBeUndefined()
  })

  it('normal mode asks for medium-risk AI workspace writes and waits for approval', async () => {
    const { gate, requests } = makeGate({ mode: 'normal' })
    const pending = gate.check(tool('fs.write'), { path: 'docs/notes.md', content: 'updated' }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'fs.write',
      risk: 'medium',
      reason: 'This changes your workspace',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('strict mode asks for medium-risk AI settings changes', async () => {
    const { gate, requests } = makeGate({ mode: 'strict' })
    const pending = gate.check(tool('settings.set'), { key: 'theme', value: 'sage' }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'settings.set',
      risk: 'medium',
      reason: 'Strict mode: every action needs approval',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('strict mode asks before every AI action, including plain reads', async () => {
    const { gate, requests } = makeGate({ mode: 'strict' })
    const pending = gate.check(tool('fs.read'), { path: 'docs/notes.md' }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'fs.read',
      reason: 'Strict mode: every action needs approval',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('normal mode asks before contacting an outside service', async () => {
    const { gate, requests } = makeGate({ mode: 'normal' })
    const pending = gate.check(tool('gmail.search'), { account: 'default' }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'gmail.search',
      reason: 'This contacts an outside service',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('normal mode asks before changing a setting (previously silent)', async () => {
    const { gate, requests } = makeGate({ mode: 'normal' })
    const pending = gate.check(tool('settings.set'), { key: 'theme', value: 'sage' }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'settings.set', reason: 'This changes your workspace' })

    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('normal mode allows local reads and navigation without prompting', async () => {
    const { gate, requests } = makeGate({ mode: 'normal' })

    await gate.check(tool('search'), { query: 'budget' }, { actor: 'ai', sessionId: 's1' })
    await gate.check(tool('editor.open'), { path: 'docs/notes.md' }, { actor: 'ai', sessionId: 's1' })

    expect(requests).toHaveLength(0)
  })

  it('exempts the runtime log append from Normal but not from Strict', async () => {
    const normal = makeGate({ mode: 'normal' })
    await normal.gate.check(tool('log.append'), { message: 'did a thing' }, { actor: 'ai', sessionId: 's1' })
    expect(normal.requests).toHaveLength(0)

    const strict = makeGate({ mode: 'strict' })
    const pending = strict.gate.check(tool('log.append'), { message: 'did a thing' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    expect(strict.requests).toHaveLength(1)
    strict.gate.respond(strict.requests[0].requestId, { approved: true })
    await pending
  })

  it('normal mode treats an unknown tool as a mutation and asks', async () => {
    const { gate, requests } = makeGate({ mode: 'normal' })
    const pending = gate.check(tool('custom.frobnicate'), { x: 1 }, { actor: 'ai', sessionId: 's1' })

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'custom.frobnicate', reason: 'This changes your workspace' })

    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('developer mode bypasses prompts but records the bypass', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'developer' })

    await gate.check(tool('fs.delete'), { path: '.env' }, { actor: 'ai', sessionId: 's1' })

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'bypassed',
      mode: 'developer',
      tool: 'fs.delete',
      pathKind: 'sensitive',
    })
  })

  it('enforces declared workspace permissions for app file reads', async () => {
    const { gate, requests, decisions } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await gate.check(tool('fs.read'), { path: 'docs/notes.md' }, { actor: 'package', package_id: 'stats-checker' })

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      actor: 'package',
      tool: 'fs.read',
      package_id: 'stats-checker',
    })
  })

  it('denies app workspace reads that were not declared', async () => {
    const { gate, requests, decisions } = makeGate({ packagePermissions: {} })

    await expect(
      gate.check(tool('fs.read'), { path: 'docs/notes.md' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('did not declare workspace read permission')

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'denied',
      actor: 'package',
      tool: 'fs.read',
      reason: 'App stats-checker did not declare workspace read permission',
    })
  })

  it('denies app writes unless workspace write permission is declared', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await expect(
      gate.check(tool('fs.write'), { path: 'docs/notes.md', content: 'x' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('did not declare workspace write permission')
    await expect(
      gate.check(tool('fs.writeBytes'), { path: 'docs/source.pdf', base64: 'AA==' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('did not declare workspace write permission')
  })

  it('denies app PDF extraction and bibliography setting unless workspace read permission is declared', async () => {
    const { gate } = makeGate({ packagePermissions: {} })

    await expect(
      gate.check(tool('documents.pdf.extract'), { path: 'docs/source.pdf' }, { actor: 'package', package_id: 'references' }),
    ).rejects.toThrow('did not declare workspace read permission')
    await expect(
      gate.check(tool('references.setBibliographyPath'), { path: 'refs/library.bib' }, { actor: 'package', package_id: 'references' }),
    ).rejects.toThrow('did not declare workspace read permission')
  })

  it('allows app PDF extraction and bibliography setting with workspace read permission', async () => {
    const { gate, requests } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await gate.check(tool('documents.pdf.extract'), { path: 'docs/source.pdf' }, { actor: 'package', package_id: 'references' })
    await gate.check(tool('references.setBibliographyPath'), { path: 'refs/library.bib' }, { actor: 'package', package_id: 'references' })

    expect(requests).toHaveLength(0)
  })

  it('denies app review-file picking unless workspace write permission is declared', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await expect(
      gate.check(tool('documents.pickReviewFile'), {}, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('did not declare workspace write permission')
  })

  it('denies app import picking and markdown import unless workspace permissions are declared', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await expect(
      gate.check(tool('documents.pickImportFile'), {}, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('did not declare workspace write permission')

    await expect(
      gate.check(tool('documents.importMarkdown'), { path: 'source.docx', output_path: 'imports/source.md' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('must declare workspace read and write permission')
  })

  it('blocks direct app access to provider keys and app management', async () => {
    const { gate } = makeGate({ packagePermissions: { ai: true, workspace: { read: true, write: true } } })

    await expect(
      gate.check(tool('ai.setKey'), { provider: 'openai', key: 'secret' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access provider keys directly')
    await expect(
      gate.check(tool('package.create'), { id: 'other-package' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot manage app installation or enablement')
  })

  it('blocks app access to personal Slack integrations', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await expect(
      gate.check(tool('slack.search'), { query: 'hello' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('personal Slack')
  })

  it('blocks app access to personal Google integrations', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await expect(
      gate.check(tool('gmail.search'), { query: 'hello' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('personal Google')
  })

  it('blocks app access to web reader and website access tools', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true }, http: ['example.com'] } })

    await expect(
      gate.check(tool('web.read'), { url: 'https://example.com', stateful: true }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access web reader tools')
    await expect(
      gate.check(tool('web.search'), { query: 'example' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access web reader tools')
    await expect(
      gate.check(tool('web.browser.open'), { url: 'https://example.com' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access web reader tools')
    await expect(
      gate.check(tool('web.live.act'), { action: 'observe' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access web reader tools')
  })

  it('allows app secret tools only for declared secret names', async () => {
    const { gate, requests, decisions } = makeGate({ packagePermissions: { secrets: ['github_token'] } })

    await gate.check(tool('package.secrets.set'), { name: 'github_token', secret: 'ghp_abc' }, { actor: 'package', package_id: 'github-monitor' })

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({ decision: 'allowed', tool: 'package.secrets.set' })

    await expect(
      gate.check(tool('package.secrets.set'), { name: 'other', secret: 'x' }, { actor: 'package', package_id: 'github-monitor' }),
    ).rejects.toThrow('App github-monitor did not declare secret: other')
    await expect(
      gate.check(tool('package.secrets.delete'), { name: 'other' }, { actor: 'package', package_id: 'github-monitor' }),
    ).rejects.toThrow('did not declare secret')
  })

  it('denies app secret set/delete when the name is missing, empty, or not a string', async () => {
    const { gate } = makeGate({ packagePermissions: { secrets: ['github_token'] } })

    await expect(
      gate.check(tool('package.secrets.set'), { secret: 'x' }, { actor: 'package', package_id: 'github-monitor' }),
    ).rejects.toThrow('require a declared secret name')
    await expect(
      gate.check(tool('package.secrets.set'), { name: '', secret: 'x' }, { actor: 'package', package_id: 'github-monitor' }),
    ).rejects.toThrow('require a declared secret name')
    await expect(
      gate.check(tool('package.secrets.delete'), { name: 123 }, { actor: 'package', package_id: 'github-monitor' }),
    ).rejects.toThrow('require a declared secret name')
    // status takes no name and stays allowed for declaring apps.
    await gate.check(tool('package.secrets.status'), {}, { actor: 'package', package_id: 'github-monitor' })
  })

  it('denies app secret tools entirely when the manifest declares no secrets', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await expect(
      gate.check(tool('package.secrets.status'), {}, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('did not declare any secrets')
  })

  it('redacts the secret value in app secrets.set audit params', async () => {
    const { gate, decisions } = makeGate({ packagePermissions: { secrets: ['github_token'] } })

    await gate.check(tool('package.secrets.set'), { name: 'github_token', secret: 'ghp_abc' }, { actor: 'package', package_id: 'github-monitor' })

    expect(decisions.at(-1)?.params).toMatchObject({ secret: '[redacted]' })
  })

  it('blocks app access to system tools and chat session storage', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true } } })

    await expect(
      gate.check(tool('workspace.open'), { path: '/Users/test/workspace' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot use system tools')
    await expect(
      gate.check(tool('session.list'), {}, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access chat session storage')
    await expect(
      gate.check(tool('skill.get'), { name: 'issue-work' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access AI skill activation state')
    await expect(
      gate.check(tool('search'), { query: 'secret' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('cannot access chat session search')
  })

  it('allows app file search only when workspace read permission is declared', async () => {
    const allowed = makeGate({ packagePermissions: { workspace: { read: true } } })
    await allowed.gate.check(tool('search'), { query: 'TODO', scope: 'files' }, { actor: 'package', package_id: 'stats-checker' })

    const denied = makeGate({ packagePermissions: {} })
    await expect(
      denied.gate.check(tool('search.files'), { query: 'TODO' }, { actor: 'package', package_id: 'stats-checker' }),
    ).rejects.toThrow('did not declare workspace read permission')
  })

  it('can allow the same tool again for the same session after approval', async () => {
    const { gate, requests, decisions } = makeGate()
    const first = gate.check(tool('fs.delete'), { path: 'old.md' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()

    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await first

    await gate.check(tool('fs.delete'), { path: 'other.md' }, { actor: 'ai', sessionId: 's1' })

    expect(requests).toHaveLength(1)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      reason: 'allowed for this session',
    })
  })

  it('grants an unapproved website access domain from the web.read approval', async () => {
    const grantSavedBrowserSessionDomain = vi.fn()
    const { gate, requests, decisions } = makeGate({
      resolveSavedBrowserSessionGrant: (name, params) => name === 'web.read' && params.stateful === true
        ? { domain: 'private.example', granted: false }
        : null,
      grantSavedBrowserSessionDomain,
    })

    const pending = gate.check(
      tool('web.read'),
      { url: 'https://private.example/page', stateful: true },
      { actor: 'ai', sessionId: 's1' },
    )
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'web.read',
      target: 'https://private.example/page',
      savedBrowserSession: {
        domain: 'private.example',
        granted: false,
      },
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending

    expect(grantSavedBrowserSessionDomain).toHaveBeenCalledWith(
      { domain: 'private.example', granted: false },
      { url: 'https://private.example/page', stateful: true },
      { actor: 'ai', sessionId: 's1' },
    )
    expect(decisions.at(-1)).toMatchObject({ decision: 'approved', tool: 'web.read' })
  })

  it('grants an unapproved website access domain from the live browser approval', async () => {
    const grantSavedBrowserSessionDomain = vi.fn()
    const { gate, requests } = makeGate({
      resolveSavedBrowserSessionGrant: (name, params) => name === 'web.live.open' && params.stateful === true
        ? { domain: 'private.example', granted: false }
        : null,
      grantSavedBrowserSessionDomain,
    })

    const pending = gate.check(
      tool('web.live.open'),
      { url: 'https://private.example/page', stateful: true },
      { actor: 'ai', sessionId: 's1' },
    )
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'web.live.open',
      target: 'https://private.example/page',
      savedBrowserSession: {
        domain: 'private.example',
        granted: false,
      },
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending

    expect(grantSavedBrowserSessionDomain).toHaveBeenCalledWith(
      { domain: 'private.example', granted: false },
      { url: 'https://private.example/page', stateful: true },
      expect.objectContaining({ actor: 'ai', sessionId: 's1' }),
    )
  })

  it('does not let a session web.read approval bypass a new website access domain grant', async () => {
    const grantSavedBrowserSessionDomain = vi.fn()
    const { gate, requests } = makeGate({
      resolveSavedBrowserSessionGrant: (_name, params) => params.stateful === true
        ? { domain: String(params.url).includes('two.example') ? 'two.example' : 'one.example', granted: false }
        : null,
      grantSavedBrowserSessionDomain,
    })

    const first = gate.check(
      tool('web.read'),
      { url: 'https://one.example/page', stateful: false },
      { actor: 'ai', sessionId: 's1' },
    )
    await Promise.resolve()
    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await first

    const second = gate.check(
      tool('web.read'),
      { url: 'https://two.example/private', stateful: true },
      { actor: 'ai', sessionId: 's1' },
    )
    await Promise.resolve()

    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      savedBrowserSession: { domain: 'two.example', granted: false },
    })
    gate.respond(requests[1].requestId, { approved: true })
    await second
    expect(grantSavedBrowserSessionDomain).toHaveBeenCalledTimes(1)
  })

  it('does not carry session approvals across sessions', async () => {
    const { gate, requests } = makeGate()
    const first = gate.check(tool('fs.delete'), { path: 'old.md' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await first

    const second = gate.check(tool('fs.delete'), { path: 'other.md' }, { actor: 'ai', sessionId: 's2' })
    await Promise.resolve()

    expect(requests).toHaveLength(2)
    gate.respond(requests[1].requestId, { approved: false })
    await expect(second).rejects.toThrow('Permission denied')
  })

  it('denies when no renderer is available to answer an approval request', async () => {
    const gate = createPermissionGate({
      getApprovalMode: () => 'normal',
      getWorkspacePath: () => '/Users/test/workspace',
      sendApprovalRequest: () => false,
      recordDecision: vi.fn(),
    })

    await expect(
      gate.check(tool('fs.delete'), { path: 'old.md' }, { actor: 'ai', sessionId: 's1' }),
    ).rejects.toThrow('No approval surface available')
  })

  it('auto-allows routine approval grants even when developer mode would otherwise bypass the gate', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'developer' })

    await gate.check(
      tool('fs.write'),
      { path: 'notes.md', content: 'hello' },
      {
        actor: 'ai',
        sessionId: 's1',
        routine: { id: 'support-bot', runId: 'routine_run_1', approvalAllow: ['fs.write'] },
      },
    )

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      tool: 'fs.write',
      actor: 'ai',
      routineId: 'support-bot',
      reason: 'routine approval grant',
    })
  })

  it('parks routine mutate calls without grants instead of applying developer mode', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'developer' })

    const pending = gate.check(
      tool('fs.write'),
      { path: 'notes.md', content: 'hello' },
      {
        actor: 'ai',
        sessionId: 's1',
        routine: { id: 'support-bot', runId: 'routine_run_1', approvalAllow: ['fs.read'] },
      },
    )
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'fs.write',
      sessionId: 's1',
      routineId: 'support-bot',
      reason: 'Routine needs approval for this tool',
    })
    expect(decisions.find(event => event.decision === 'requested')).toMatchObject({
      tool: 'fs.write',
      routineId: 'support-bot',
      reason: 'Routine needs approval for this tool',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('allows routine baseline reads and search without declarative grants', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'developer' })
    const ctx = {
      actor: 'ai' as const,
      sessionId: 's1',
      routine: { id: 'support-bot', runId: 'routine_run_1', approvalAllow: [] },
    }

    await gate.check(tool('fs.read'), { path: 'notes.md' }, ctx)
    await gate.check(tool('search'), { query: 'budget' }, ctx)

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      routineId: 'support-bot',
      reason: 'routine baseline',
    })
  })

  it('still parks routine granted tools for sensitive paths', async () => {
    const { gate, requests } = makeGate()

    const pending = gate.check(
      tool('fs.write'),
      { path: '.env', content: 'x' },
      {
        actor: 'ai',
        sessionId: 's1',
        routine: { id: 'support-bot', runId: 'routine_run_1', approvalAllow: ['fs.write'] },
      },
    )
    await Promise.resolve()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'fs.write',
      routineId: 'support-bot',
      pathKind: 'sensitive',
    })
    gate.respond(requests[0].requestId, { approved: false })
    await expect(pending).rejects.toThrow('Permission denied')
  })
})

describe('approval preview', () => {
  it('derives a reviewable change shape for each file mutation', () => {
    expect(buildApprovalPreview('fs.edit', { path: 'a.md', old_text: 'a', new_text: 'b' }))
      .toEqual({ kind: 'edit', oldText: 'a', newText: 'b' })
    expect(buildApprovalPreview('fs.write', { path: 'a.md', content: 'hello' }))
      .toEqual({ kind: 'write', content: 'hello' })
    expect(buildApprovalPreview('fs.create', { path: 'a.md', content: 'hi' }))
      .toEqual({ kind: 'create', content: 'hi' })
    expect(buildApprovalPreview('fs.delete', { path: 'a.md' }))
      .toEqual({ kind: 'delete' })
  })

  it('has no preview for tools without a reviewable change', () => {
    expect(buildApprovalPreview('terminal.run', { command: 'ls' })).toBeUndefined()
    expect(buildApprovalPreview('slack.send', { channel: '#x', text: 'hi' })).toBeUndefined()
  })

  it('carries un-redacted content to the UI while the audit event stays redacted', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'normal' })
    const pending = gate.check(
      tool('fs.write'),
      { path: 'docs/notes.md', content: 'secret plan text' },
      { actor: 'ai', sessionId: 's1' },
    )
    await Promise.resolve()

    // The request the user sees can show the real change...
    expect(requests[0].preview).toEqual({ kind: 'write', content: 'secret plan text' })
    // ...but the recorded audit event must never carry file content.
    const requested = decisions.find(event => event.decision === 'requested')
    expect(requested?.params?.content).toBe('[redacted]')

    gate.respond(requests[0].requestId, { approved: true })
    await pending

    const approved = decisions.find(event => event.decision === 'approved')
    expect(approved?.params?.content).toBe('[redacted]')
  })
})

describe('app, skill, and app-owned named tool policies', () => {
  it('keeps app-specific names out of the static core policy map', () => {
    expect(getToolPolicy('issues.list')).toEqual({ category: 'general', risk: 'low', label: 'issues.list' })
    expect(getToolPolicy('knowledge.list')).toEqual({ category: 'general', risk: 'low', label: 'knowledge.list' })
    expect(getToolPolicy('issues.delete')).toEqual({ category: 'general', risk: 'low', label: 'issues.delete' })
  })

  it('classifies skill and app tools as core policies', () => {
    expect(getToolPolicy('skill.list')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('skill.get')).toMatchObject({ category: 'read', risk: 'low', targetParam: 'name' })
    expect(getToolPolicy('skill.setDisabled')).toMatchObject({ category: 'settings', risk: 'medium', targetParam: 'name' })
    expect(getToolPolicy('skill.create')).toMatchObject({ category: 'write', risk: 'medium', targetParam: 'name' })
    expect(getToolPolicy('skill.update')).toMatchObject({ category: 'write', risk: 'medium', targetParam: 'name' })
    expect(getToolPolicy('skill.templateList')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('skill.templateContent')).toMatchObject({ category: 'read', risk: 'low', targetParam: 'templateId' })
    expect(getToolPolicy('app.status')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('app.enable')).toMatchObject({ category: 'settings', risk: 'medium', targetParam: 'id' })
    expect(getToolPolicy('app.disable')).toMatchObject({ category: 'settings', risk: 'medium', targetParam: 'id' })
    expect(getToolPolicy('app.trust')).toMatchObject({ category: 'settings', risk: 'high', targetParam: 'id' })
    expect(getToolPolicy('app.templateList')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('app.templateContent')).toMatchObject({ category: 'read', risk: 'low', targetParam: 'templateId' })
    expect(getToolPolicy('package.validate')).toMatchObject({ category: 'read', risk: 'low', targetParam: 'id' })
    expect(getToolPolicy('package.reload')).toMatchObject({ category: 'settings', risk: 'medium', targetParam: 'id' })
  })
})

describe('app-owned named tool permission enforcement', () => {
  const pkg = { actor: 'package' as const, package_id: 'board' }

  it('allows an app to call its own named tools without approval', async () => {
    const { gate, requests } = makeGate({
      packagePermissions: { workspace: { read: true, write: true } },
      getDynamicToolPolicy: name => name === 'issues.delete'
        ? { category: 'write', risk: 'high', label: 'Board: Delete issue', ownerPackageId: 'board' }
        : undefined,
    })

    await gate.check(tool('issues.delete'), { id: 'issue-1' }, { actor: 'package', package_id: 'board' })

    expect(requests).toHaveLength(0)
  })

  it('denies apps calling named tools owned by another app', async () => {
    const { gate } = makeGate({
      packagePermissions: { workspace: { read: true, write: true } },
      getDynamicToolPolicy: name => name === 'issues.delete'
        ? { category: 'write', risk: 'high', label: 'Board: Delete issue', ownerPackageId: 'board' }
        : undefined,
    })

    await expect(
      gate.check(tool('issues.delete'), { id: 'issue-1' }, { actor: 'package', package_id: 'knowledge' }),
    ).rejects.toThrow('cannot call tools owned by app board')
  })

  it('uses dynamic named-tool policy for AI approval requests', async () => {
    const { gate, requests } = makeGate({
      getDynamicToolPolicy: name => name === 'knowledge.delete'
        ? { category: 'write', risk: 'high', label: 'Knowledge: Delete note', ownerPackageId: 'knowledge' }
        : undefined,
    })

    const pending = gate.check(tool('knowledge.delete'), { id: 'note-1' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()

    expect(requests[0]).toMatchObject({
      toolName: 'knowledge.delete',
      label: 'Knowledge: Delete note',
      category: 'write',
      risk: 'high',
      reason: 'This changes your workspace',
    })
    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('denies skill catalog tools to apps', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    for (const name of ['skill.list', 'skill.get', 'skill.setDisabled', 'skill.create', 'skill.update', 'skill.templateList', 'skill.templateContent']) {
      await expect(gate.check(tool(name), {}, pkg)).rejects.toThrow('cannot access AI skill activation state')
    }
  })

  it('denies app template authoring tools to apps', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    for (const name of ['app.templateList', 'app.templateContent']) {
      await expect(gate.check(tool(name), { templateId: 'word-count' }, pkg)).rejects.toThrow('cannot access app starter templates')
    }
  })

  it('lets the board app toggle its own enablement (id = board)', async () => {
    const { gate, requests } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    await gate.check(tool('app.enable'), { id: 'board' }, { actor: 'package', package_id: 'board' })
    await gate.check(tool('app.disable'), { id: 'board' }, { actor: 'package', package_id: 'board' })
    expect(requests).toHaveLength(0)
  })

  it('lets the knowledge app toggle its own enablement (id = knowledge)', async () => {
    const { gate, requests } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    await gate.check(tool('app.enable'), { id: 'knowledge' }, { actor: 'package', package_id: 'knowledge' })
    expect(requests).toHaveLength(0)
  })

  it('denies an app toggling any id that is not its own', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    await expect(
      gate.check(tool('app.enable'), { id: 'knowledge' }, { actor: 'package', package_id: 'board' }),
    ).rejects.toThrow(PermissionDeniedError)
    await expect(
      gate.check(tool('app.enable'), { id: 'board' }, { actor: 'package', package_id: 'docx-review' }),
    ).rejects.toThrow(PermissionDeniedError)
    await expect(
      gate.check(tool('app.disable'), { id: 'board' }, { actor: 'package', package_id: 'knowledge' }),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it('denies app.trust to app actors entirely, even for their own id', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    await expect(
      gate.check(tool('app.trust'), { id: 'board' }, { actor: 'package', package_id: 'board' }),
    ).rejects.toThrow('cannot acknowledge app trust')
  })

  it('allows the user actor everything', async () => {
    const { gate, requests } = makeGate({
      getDynamicToolPolicy: name => name === 'issues.delete'
        ? { category: 'write', risk: 'high', label: 'Board: Delete issue', ownerPackageId: 'board' }
        : undefined,
    })
    const u = { actor: 'user' as const }
    for (const name of [
      'issues.delete',
      'skill.list', 'skill.get',
      'app.status', 'app.enable', 'app.disable', 'app.trust',
    ]) {
      await gate.check(tool(name), { id: 'board' }, u)
    }
    expect(requests).toHaveLength(0)
  })
})

describe('enablement ledger is protected from direct fs.write (Decision 12)', () => {
  it('prompts before AI writes to the enablement ledger in normal mode', async () => {
    const { gate, requests } = makeGate({ mode: 'normal' })
    const pending = gate.check(
      tool('fs.write'),
      { path: '.mim/packages/enabled.json', content: '{"trusted":["vendored@*"]}' },
      { actor: 'ai', sessionId: 's1' },
    )

    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'fs.write',
      pathKind: 'sensitive',
      reason: 'App enablement ledger',
    })

    gate.respond(requests[0].requestId, { approved: false })
    await expect(pending).rejects.toThrow('Permission denied')
  })

  it('denies app actors from writing to the enablement ledger even with workspace.write', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })

    await expect(
      gate.check(
        tool('fs.write'),
        { path: '.mim/packages/enabled.json', content: '{"trusted":["vendored@*"]}' },
        { actor: 'package', package_id: 'evil-pkg' },
      ),
    ).rejects.toThrow(PermissionDeniedError)
  })
})

describe('app.trust is user-only', () => {
  it('hard-denies the ai actor without ever prompting', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'normal' })

    await expect(
      gate.check(tool('app.trust'), { id: 'vendored' }, { actor: 'ai', sessionId: 's1' }),
    ).rejects.toThrow('Trust acknowledgement is user-only')

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'denied',
      tool: 'app.trust',
      actor: 'ai',
      reason: 'Trust acknowledgement is user-only',
    })
  })

  it('hard-denies the ai actor even in developer mode (mirrors readonly-resource writes)', async () => {
    const { gate, requests } = makeGate({ mode: 'developer' })
    await expect(
      gate.check(tool('app.trust'), { id: 'vendored' }, { actor: 'ai' }),
    ).rejects.toThrow('Trust acknowledgement is user-only')
    expect(requests).toHaveLength(0)
  })

  it('still allows the user actor for app.trust', async () => {
    const { gate, requests } = makeGate({ mode: 'strict' })
    await gate.check(tool('app.trust'), { id: 'vendored' }, { actor: 'user' })
    expect(requests).toHaveLength(0)
  })

})

describe('permission parameter redaction', () => {
  it('redacts secrets and file content but keeps useful targeting fields', () => {
    expect(redactPermissionParams({
      path: '.env',
      content: 'SECRET=1',
      apiKey: 'sk-test',
      password: 'pw',
      command: 'npm test',
      nested: { token: 'abc', visible: 'ok' },
    })).toEqual({
      path: '.env',
      content: '[redacted]',
      apiKey: '[redacted]',
      password: '[redacted]',
      command: 'npm test',
      nested: { token: '[redacted]', visible: 'ok' },
    })
  })
})

describe('Team source write policy', () => {
  it('allows direct user writes into Team Files', async () => {
    const { gate, requests, decisions } = makeGate()
    await gate.check(tool('fs.write'), { path: '.mim/team/files/limitations.md', content: 'x' }, { actor: 'user' })
    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({ decision: 'allowed', reason: 'direct user action' })
  })

  it('asks before AI writes into Team Files and proceeds on approval', async () => {
    const { gate, requests } = makeGate()
    const pending = gate.check(
      tool('fs.write'),
      { path: '.mim/team/files/limitations.md', content: 'x' },
      { actor: 'ai', sessionId: 's1' },
    )
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ pathKind: 'team', reason: 'Team file write requires approval' })
    gate.respond(requests[0].requestId, { approved: true })
    await expect(pending).resolves.toBeUndefined()
  })

  it('bypasses the Team-file prompt in developer mode', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'developer' })
    await gate.check(tool('fs.write'), { path: '.mim/team/files/x.md', content: 'x' }, { actor: 'ai' })
    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({ decision: 'bypassed' })
  })

  it('protects the Team checkout mount itself from mutation', async () => {
    const { gate } = makeGate()
    await expect(
      gate.check(tool('fs.delete'), { path: '.mim/team' }, { actor: 'user' }),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it('leaves reads inside Team Files ungated for AI', async () => {
    const { gate, requests, decisions } = makeGate()
    await gate.check(tool('fs.read'), { path: '.mim/team/files/proposal.md' }, { actor: 'ai', sessionId: 's1' })
    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({ decision: 'allowed', pathKind: 'team' })
  })

  it('lets apps write Team Files only with workspace.write', async () => {
    const permissions: PackagePermissions = { workspace: { read: true, write: true } }
    const { gate } = makeGate({ packagePermissions: permissions })
    await expect(
      gate.check(tool('fs.write'), { path: '.mim/team/files/x.md', content: 'x' }, { actor: 'package', package_id: 'p1' }),
    ).resolves.toBeUndefined()
    const withoutWrite = makeGate({ packagePermissions: { workspace: { read: true } } }).gate
    await expect(
      withoutWrite.check(tool('fs.write'), { path: '.mim/team/files/x.md', content: 'x' }, { actor: 'package', package_id: 'p1' }),
    ).rejects.toThrow(PermissionDeniedError)
  })
})

describe('instruction and skill origin policy', () => {
  it('allows direct user writes to Personal skill documents', async () => {
    const { gate, requests } = makeGate()
    await gate.check(
      tool('fs.write'),
      { path: '.mim/origins/you/skills/email/SKILL.md', content: 'x' },
      { actor: 'user' },
    )
    expect(requests).toHaveLength(0)
  })

  it('hard-denies writes to Mim built-ins for every actor', async () => {
    const { gate, requests } = makeGate({ mode: 'developer' })
    await expect(gate.check(
      tool('fs.write'),
      { path: '.mim/origins/mim/skills/build-app/SKILL.md', content: 'x' },
      { actor: 'user' },
    )).rejects.toThrow('read-only')
    expect(requests).toHaveLength(0)
  })

  it('denies app access to Personal origin documents', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    await expect(gate.check(
      tool('fs.read'),
      { path: '.mim/origins/you/instructions.md' },
      { actor: 'package', package_id: 'p1' },
    )).rejects.toThrow(PermissionDeniedError)
  })
})

describe('Team tool policies', () => {
  it('classifies Team discovery separately from connection, checking, and updating', () => {
    expect(getToolPolicy('team.status')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('team.open')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('team.connect')).toMatchObject({
      category: 'network',
      risk: 'medium',
      targetParam: 'repository',
    })
    expect(getToolPolicy('team.check')).toMatchObject({ category: 'network', risk: 'medium' })
    expect(getToolPolicy('team.update')).toMatchObject({ category: 'network', risk: 'medium' })
  })

  it('keeps the Team connection and checkout unavailable to apps', async () => {
    const permissions: PackagePermissions = { workspace: { read: true, write: true } }
    const { gate } = makeGate({ packagePermissions: permissions })
    for (const name of ['team.status', 'team.open', 'team.connect', 'team.check', 'team.update']) {
      await expect(
        gate.check(tool(name), {}, { actor: 'package', package_id: 'p1' }),
      ).rejects.toThrow(PermissionDeniedError)
    }
  })

  it('keeps the Personal config behind a read policy and unavailable to apps', async () => {
    expect(getToolPolicy('config.get')).toMatchObject({ category: 'read', risk: 'low' })
    const { gate } = makeGate({
      packagePermissions: { workspace: { read: true, write: true } },
    })
    await expect(
      gate.check(tool('config.get'), {}, { actor: 'package', package_id: 'p1' }),
    ).rejects.toThrow(PermissionDeniedError)
  })
})

describe('sensitive-path floor beats session always-allow (Fix 1)', () => {
  it('still prompts for a sensitive path even with session always-allow active', async () => {
    const { gate, requests, decisions } = makeGate()
    // First, get always-allow for fs.write
    const first = gate.check(tool('fs.write'), { path: 'docs/notes.md', content: 'x' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await first

    // Second call to a sensitive path with the same tool => should still prompt
    const second = gate.check(tool('fs.write'), { path: '.env', content: 'SECRET=1' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()

    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      toolName: 'fs.write',
      pathKind: 'sensitive',
    })

    gate.respond(requests[1].requestId, { approved: true })
    await second
  })

  it('still prompts for an outside-workspace path even with session always-allow active', async () => {
    const { gate, requests } = makeGate()
    // Get always-allow for workspace.open
    const first = gate.check(tool('workspace.open'), { path: '/Users/test/other-project' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await first

    // Call the same tool to another outside-workspace path => still prompts
    const second = gate.check(tool('workspace.open'), { path: '/Users/test/Downloads/client-work' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()

    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      toolName: 'workspace.open',
      pathKind: 'outside-workspace',
    })

    gate.respond(requests[1].requestId, { approved: true })
    await second
  })

  it('skips the prompt for ordinary workspace paths when session always-allow is active', async () => {
    const { gate, requests, decisions } = makeGate()
    // Get always-allow for fs.write
    const first = gate.check(tool('fs.write'), { path: 'docs/notes.md', content: 'x' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await first

    // Second call to an ordinary workspace path => should skip (session allow applies)
    await gate.check(tool('fs.write'), { path: 'docs/other.md', content: 'y' }, { actor: 'ai', sessionId: 's1' })
    expect(requests).toHaveLength(1)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      reason: 'allowed for this session',
    })
  })
})

describe('durable approval-decision audit (Fix 2)', () => {
  it('persists only decisions that represent a real approval, denial, or bypass', () => {
    const append = vi.fn()
    const trace = { append } as unknown as TraceLog
    const base: PermissionDecisionEvent = {
      decision: 'allowed',
      tool: 'fs.read',
      actor: 'user',
      category: 'read',
      risk: 'low',
      mode: 'normal',
      reason: 'direct user action',
    }

    traceGateDecision(trace, base)
    traceGateDecision(trace, { ...base, actor: 'ai', decision: 'requested' })
    traceGateDecision(trace, { ...base, actor: 'ai', decision: 'approved' })
    traceGateDecision(trace, { ...base, actor: 'ai', decision: 'denied' })
    traceGateDecision(trace, { ...base, actor: 'ai', decision: 'bypassed' })

    expect(append).toHaveBeenCalledTimes(4)
    expect(append.mock.calls.map(([event]) => event.data.decision)).toEqual([
      'requested', 'approved', 'denied', 'bypassed',
    ])
  })

  it('emits a permission.decision event via recordDecision for each gate decision', async () => {
    const decisions: PermissionDecisionEvent[] = []
    const { gate, requests } = makeGate({ decisions })

    // A simple allow (user actor)
    await gate.check(tool('fs.read'), { path: 'notes.md' }, { actor: 'user' })
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      tool: 'fs.read',
      actor: 'user',
      reason: 'direct user action',
    })

    // An AI approval flow
    const pending = gate.check(tool('fs.write'), { path: 'a.md', content: 'x' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()

    const requested = decisions.find(d => d.decision === 'requested')
    expect(requested).toMatchObject({
      tool: 'fs.write',
      actor: 'ai',
      sessionId: 's1',
    })

    gate.respond(requests[0].requestId, { approved: true })
    await pending

    const approved = decisions.find(d => d.decision === 'approved')
    expect(approved).toMatchObject({ tool: 'fs.write', decision: 'approved' })
  })

  it('keeps params redacted in decision events', async () => {
    const decisions: PermissionDecisionEvent[] = []
    const { gate } = makeGate({ decisions })

    await gate.check(tool('fs.write'), { path: '.env', content: 'SECRET=abc' }, { actor: 'user' })
    expect(decisions.at(-1)?.params?.content).toBe('[redacted]')
  })

  it('carries the tool call trace context on decision events', async () => {
    const decisions: PermissionDecisionEvent[] = []
    const { gate } = makeGate({ decisions })

    await gate.check(
      tool('fs.read'),
      { path: 'notes.md' },
      { actor: 'user', traceId: 'trace-1', spanId: 'span-1' },
    )
    expect(decisions.at(-1)).toMatchObject({
      traceId: 'trace-1',
      parentSpanId: 'span-1',
    })
  })
})

describe('cancel session resolves pending approvals as denied (Fix 4)', () => {
  it('resolves pending approval promises as denied when cancelSession is called', async () => {
    const { gate, requests, decisions } = makeGate()
    const pending = gate.check(tool('fs.write'), { path: 'a.md', content: 'x' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()

    expect(requests).toHaveLength(1)

    gate.cancelSession('s1')

    await expect(pending).rejects.toThrow(PermissionDeniedError)

    expect(decisions.at(-1)).toMatchObject({
      decision: 'denied',
    })
  })

  it('clears sessionToolAllows when cancelSession is called', async () => {
    const { gate, requests } = makeGate()
    // Get an always-allow
    const first = gate.check(tool('fs.write'), { path: 'a.md', content: 'x' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await first

    // Verify always-allow works
    await gate.check(tool('fs.write'), { path: 'b.md', content: 'y' }, { actor: 'ai', sessionId: 's1' })
    expect(requests).toHaveLength(1)

    // Cancel the session
    gate.cancelSession('s1')

    // Now the always-allow should be gone, so a new check must prompt
    const after = gate.check(tool('fs.write'), { path: 'c.md', content: 'z' }, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    expect(requests).toHaveLength(2)

    gate.respond(requests[1].requestId, { approved: true })
    await after
  })

  it('does not affect pending approvals for a different session', async () => {
    const { gate, requests } = makeGate()
    const pending1 = gate.check(tool('fs.write'), { path: 'a.md', content: 'x' }, { actor: 'ai', sessionId: 's1' })
    const pending2 = gate.check(tool('fs.write'), { path: 'b.md', content: 'y' }, { actor: 'ai', sessionId: 's2' })
    await Promise.resolve()

    expect(requests).toHaveLength(2)

    gate.cancelSession('s1')

    await expect(pending1).rejects.toThrow(PermissionDeniedError)

    // s2 is still pending, respond to it normally
    gate.respond(requests[1].requestId, { approved: true })
    await expect(pending2).resolves.toBeUndefined()
  })
})

describe('subagent authority', () => {
  const parentDelegation = {
    rootSessionId: 'root',
    parentSessionId: 'root',
    depth: 0,
    toolAllowlist: ['subagent.spawn', 'fs.read', 'fs.write'],
    originActor: 'ai' as const,
  }

  it('classifies delegation controls and hard-denies package actors', async () => {
    expect(getToolPolicy('subagent.spawn')).toMatchObject({ category: 'general', risk: 'medium' })
    expect(getToolPolicy('subagent.wait')).toMatchObject({ category: 'read', risk: 'low' })
    const { gate } = makeGate({ mode: 'developer' })
    await expect(gate.check(
      tool('subagent.spawn'),
      { prompt: 'escape' },
      { actor: 'package', package_id: 'app' },
    )).rejects.toThrow('Apps cannot create or control subagents')
  })

  it('enforces the inherited effective tool surface at the gate', async () => {
    const { gate } = makeGate({ mode: 'developer' })
    await expect(gate.check(
      tool('web.read'),
      { url: 'https://example.com' },
      { actor: 'ai', sessionId: 'child', subagent: parentDelegation },
    )).rejects.toThrow('outside the delegated tool surface')
  })

  it('shares always-allow grants across one task lineage but not an unrelated root', async () => {
    const { gate, requests } = makeGate()
    const parent = gate.check(
      tool('fs.write'),
      { path: 'docs/a.md', content: 'a' },
      { actor: 'ai', sessionId: 'root', subagent: parentDelegation },
    )
    await Promise.resolve()
    gate.respond(requests[0].requestId, { approved: true, alwaysAllow: true })
    await parent

    await gate.check(
      tool('fs.write'),
      { path: 'docs/b.md', content: 'b' },
      {
        actor: 'ai',
        sessionId: 'child',
        subagent: { ...parentDelegation, parentSessionId: 'root', depth: 1 },
      },
    )
    expect(requests).toHaveLength(1)

    const unrelated = gate.check(
      tool('fs.write'),
      { path: 'docs/c.md', content: 'c' },
      {
        actor: 'ai',
        sessionId: 'other-child',
        subagent: { ...parentDelegation, rootSessionId: 'other', parentSessionId: 'other', depth: 1 },
      },
    )
    await Promise.resolve()
    expect(requests).toHaveLength(2)
    gate.respond(requests[1].requestId, { approved: false })
    await expect(unrelated).rejects.toThrow(PermissionDeniedError)
  })

  it('mints requested grants only after spawn approval and carries lineage into the request', async () => {
    const { gate, requests } = makeGate()
    const pending = gate.check(
      tool('subagent.spawn'),
      { prompt: 'Implement it', requestedGrants: ['fs.write'] },
      { actor: 'ai', sessionId: 'root', subagent: parentDelegation },
    )
    await Promise.resolve()
    expect(requests[0]).toMatchObject({
      subagentRootSessionId: 'root',
      subagentParentSessionId: 'root',
      subagentDepth: 0,
    })
    gate.respond(requests[0].requestId, { approved: true })
    await pending

    await gate.check(
      tool('fs.write'),
      { path: 'docs/from-child.md', content: 'ok' },
      {
        actor: 'ai',
        sessionId: 'child',
        subagent: { ...parentDelegation, parentSessionId: 'root', depth: 1, requestedGrants: ['fs.write'] },
      },
    )
    expect(requests).toHaveLength(1)
  })

})

describe('agent session tool policies', () => {
  it('classifies agent catalog and session reads as low-risk reads', () => {
    expect(getToolPolicy('agent.list')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('agent.sessions.list')).toMatchObject({ category: 'read', risk: 'low' })
    expect(getToolPolicy('agent.sessions.get')).toMatchObject({ category: 'read', risk: 'low', targetParam: 'sessionId' })
    expect(toolEffect('agent.list')).toBe('read')
    expect(toolEffect('agent.sessions.list')).toBe('read')
    expect(toolEffect('agent.sessions.get')).toBe('read')
  })

  it('classifies session housekeeping as ui actions and launch/kill as medium general', () => {
    expect(getToolPolicy('agent.sessions.rename')).toMatchObject({ category: 'ui', risk: 'low', targetParam: 'sessionId' })
    expect(getToolPolicy('agent.sessions.archive')).toMatchObject({ category: 'ui', risk: 'low', targetParam: 'sessionId' })
    expect(getToolPolicy('agent.sessions.delete')).toMatchObject({ category: 'ui', risk: 'medium', targetParam: 'sessionId' })
    expect(getToolPolicy('agent.launch')).toMatchObject({ category: 'general', risk: 'medium', targetParam: 'agentId' })
    expect(getToolPolicy('agent.stop')).toMatchObject({ category: 'general', risk: 'medium', targetParam: 'sessionId' })
  })
})

describe('agent.launch / agent.stop are user-only (agent-sessions decision 4)', () => {
  it('hard-denies the ai actor without ever prompting', async () => {
    const { gate, requests, decisions } = makeGate({ mode: 'normal' })

    for (const name of ['agent.launch', 'agent.stop']) {
      await expect(
        gate.check(tool(name), { agentId: 'claude-code', sessionId: 's1' }, { actor: 'ai', sessionId: 's1' }),
      ).rejects.toThrow('Agent sessions are user-only')
    }

    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'denied',
      tool: 'agent.stop',
      actor: 'ai',
      reason: 'Agent sessions are user-only',
    })
  })

  it('hard-denies the ai actor even in developer mode', async () => {
    const { gate, requests } = makeGate({ mode: 'developer' })
    await expect(
      gate.check(tool('agent.launch'), { agentId: 'claude-code' }, { actor: 'ai' }),
    ).rejects.toThrow('Agent sessions are user-only')
    expect(requests).toHaveLength(0)
  })

  it('still allows the user actor without prompting', async () => {
    const { gate, requests } = makeGate({ mode: 'strict' })
    await gate.check(tool('agent.launch'), { agentId: 'claude-code' }, { actor: 'user' })
    await gate.check(tool('agent.stop'), { sessionId: 's1' }, { actor: 'user' })
    expect(requests).toHaveLength(0)
  })
})

describe('agent tools are denied to app actors', () => {
  it('denies every agent.* tool even with full workspace permissions', async () => {
    const { gate } = makeGate({ packagePermissions: { workspace: { read: true, write: true } } })
    for (const name of [
      'agent.list', 'agent.launch', 'agent.stop',
      'agent.sessions.list', 'agent.sessions.get', 'agent.sessions.rename',
      'agent.sessions.archive', 'agent.sessions.delete',
    ]) {
      await expect(
        gate.check(tool(name), { agentId: 'claude-code', sessionId: 's1' }, { actor: 'package', package_id: 'board' }),
      ).rejects.toThrow('cannot access agent sessions')
    }
  })
})

describe('dynamic tool policy provider', () => {
  const dynamicPolicies: Record<string, ToolPolicy> = {
    'board.deleteIssue': { category: 'write', risk: 'high', label: 'Board: Delete issue' },
    'board.listIssues': { category: 'read', risk: 'low', label: 'Board: List issues' },
    'github.sync': { category: 'network', risk: 'medium', label: 'GitHub: Sync' },
    // Attempt to override a core tool — should be ignored
    'fs.read': { category: 'write', risk: 'high', label: 'Malicious override' },
  }
  const getDynamic = (name: string) => dynamicPolicies[name]

  it('uses the dynamic policy for unknown tool names', async () => {
    const { gate, requests, decisions } = makeGate({ getDynamicToolPolicy: getDynamic })
    await gate.check(tool('board.listIssues'), {}, { actor: 'ai', sessionId: 's1' })
    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      category: 'read',
      risk: 'low',
    })
  })

  it('static map wins over a conflicting dynamic policy for core tools', async () => {
    const { gate, requests, decisions } = makeGate({ getDynamicToolPolicy: getDynamic })
    // fs.read is category:'read' risk:'low' in TOOL_POLICIES; dynamic says write/high
    await gate.check(tool('fs.read'), { path: 'docs/notes.md' }, { actor: 'ai', sessionId: 's1' })
    expect(requests).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({
      decision: 'allowed',
      category: 'read',
      risk: 'low',
    })
  })

  it('AI + dynamic write/high triggers approval with mutate effect, label carried through', async () => {
    const { gate, requests } = makeGate({ getDynamicToolPolicy: getDynamic })
    const pending = gate.check(tool('board.deleteIssue'), {}, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'board.deleteIssue',
      category: 'write',
      risk: 'high',
      label: 'Board: Delete issue',
      reason: 'This changes your workspace',
    })
    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('AI + dynamic read/low is allowed without prompt in normal mode', async () => {
    const { gate, requests } = makeGate({ getDynamicToolPolicy: getDynamic })
    await gate.check(tool('board.listIssues'), {}, { actor: 'ai', sessionId: 's1' })
    expect(requests).toHaveLength(0)
  })

  it('strict mode still prompts for dynamic read tools', async () => {
    const { gate, requests } = makeGate({ mode: 'strict', getDynamicToolPolicy: getDynamic })
    const pending = gate.check(tool('board.listIssues'), {}, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'board.listIssues',
      reason: 'Strict mode: every action needs approval',
    })
    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('AI + dynamic network/medium triggers external approval', async () => {
    const { gate, requests } = makeGate({ getDynamicToolPolicy: getDynamic })
    const pending = gate.check(tool('github.sync'), {}, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'github.sync',
      reason: 'This contacts an outside service',
      label: 'GitHub: Sync',
    })
    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })

  it('falls back to general/low default when neither static nor dynamic matches', async () => {
    const { gate, requests } = makeGate({ getDynamicToolPolicy: getDynamic })
    const pending = gate.check(tool('completely.unknown'), {}, { actor: 'ai', sessionId: 's1' })
    await Promise.resolve()
    // general category → mutate effect → prompts
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'completely.unknown', category: 'general' })
    gate.respond(requests[0].requestId, { approved: true })
    await pending
  })
})

describe('app-actor sanity for dynamic-policy tools', () => {
  const getDynamic = (name: string): ToolPolicy | undefined => {
    const policies: Record<string, ToolPolicy> = {
      'metrics.query': { category: 'general', risk: 'low', label: 'Metrics: Query' },
      'analytics.export': { category: 'write', risk: 'medium', label: 'Analytics: Export' },
    }
    return policies[name]
  }

  it('allows an app calling a dynamic general/low tool (cross-app is intentional)', async () => {
    const { gate, requests } = makeGate({
      packagePermissions: { workspace: { read: true } },
      getDynamicToolPolicy: getDynamic,
    })
    await gate.check(tool('metrics.query'), {}, { actor: 'package', package_id: 'dashboard' })
    expect(requests).toHaveLength(0)
  })

  it('allows an app calling a dynamic write tool without pathParam (no workspace-write check)', async () => {
    const { gate, requests } = makeGate({
      packagePermissions: { workspace: { read: true } },
      getDynamicToolPolicy: getDynamic,
    })
    // analytics.export is category:'write' but has no pathParam, so the
    // workspace-write permission check (which is pathParam-gated) does not fire.
    await gate.check(tool('analytics.export'), {}, { actor: 'package', package_id: 'dashboard' })
    expect(requests).toHaveLength(0)
  })

  it('hard-deny lists still apply to app actors regardless of dynamic policy', async () => {
    const evilDynamic = (name: string): ToolPolicy | undefined => {
      if (name === 'terminal.run') return { category: 'general', risk: 'low' }
      return undefined
    }
    const { gate } = makeGate({
      packagePermissions: { workspace: { read: true, write: true } },
      getDynamicToolPolicy: evilDynamic,
    })
    // terminal.run is in TOOL_POLICIES (system/high), static wins, and
    // packagePermissionViolation hard-denies system tools for packages.
    await expect(
      gate.check(tool('terminal.run'), { command: 'rm -rf /' }, { actor: 'package', package_id: 'evil' }),
    ).rejects.toThrow('cannot use system tools')
  })
})
