import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parse as parseYaml } from 'yaml'
import { createTraceLog } from '@main/trace/trace.js'
import { createMemorySecretStore, MIM_KEYCHAIN_SERVICE } from '@main/integrations/secrets.js'
import { createToolRegistry } from '@main/tools/registry.js'
import type { HttpClient } from '@main/integrations/http.js'
import { slackAppSecretAccount, slackBotSecretAccount, slackSecretAccount } from './client.js'
import { registerSlackTools } from './tools.js'

function fakeHttp(response: unknown, calls: Array<Record<string, unknown>> = []): HttpClient {
  return {
    async request(input) {
      calls.push(input)
      return {
        ok: true,
        status: 200,
        async json() { return response },
        async text() { return JSON.stringify(response) },
      }
    },
  }
}

describe('Slack tools', () => {
  let dir: string
  let tools: ReturnType<typeof createToolRegistry>
  const ctx = { actor: 'user' as const }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-slack-tools-'))
    tools = createToolRegistry(createTraceLog())
    tools.setWorkspacePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('declares inputSchema on every Slack tool', () => {
    registerSlackTools(tools, { secrets: createMemorySecretStore(), http: fakeHttp({ ok: true }) })
    for (const name of [
      'slack.setToken',
      'slack.deleteToken',
      'slack.status',
      'slack.channels',
      'slack.users',
      'slack.dms',
      'slack.history',
      'slack.search',
      'slack.send',
      'slack.connect',
      'slack.disconnect',
      'slack.bot.status',
      'slack.bot.connect',
      'slack.bot.disconnect',
      'slack.bot.setup',
      'slack.bot.check',
      'slack.listener.status',
      'slack.replies',
    ]) {
      expect(tools.get(name)?.inputSchema, name).toBeDefined()
    }
  })

  it('stores Slack tokens without returning the secret', async () => {
    const secrets = createMemorySecretStore()
    registerSlackTools(tools, { secrets, http: fakeHttp({ ok: true }) })

    const result = await tools.call('slack.setToken', {
      account: 'dark-peak',
      token: 'xoxb-secret',
    }, ctx)

    expect(result).toEqual({ account: 'dark-peak', configured: true })
    expect(secrets.dump()).toEqual({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('dark-peak')}`]: 'xoxb-secret',
    })
  })

  it('ignores the retired mim.yaml Slack account and uses the Personal default', async () => {
    writeFileSync(join(dir, 'mim.yaml'), 'name: demo\nslack: dark-peak\n')
    const calls: Array<Record<string, unknown>> = []
    const secrets = createMemorySecretStore({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]: 'xoxb-secret',
    })
    registerSlackTools(tools, { secrets, http: fakeHttp({ ok: true, messages: { matches: [] } }, calls) })

    await tools.call('slack.search', { query: 'budget' }, ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer xoxb-secret' })
  })

  it('status returns configured false without calling Slack when no token exists', async () => {
    const calls: Array<Record<string, unknown>> = []
    registerSlackTools(tools, { secrets: createMemorySecretStore(), http: fakeHttp({ ok: true }, calls) })

    const result = await tools.call('slack.status', {}, ctx)

    expect(result).toEqual({ account: 'default', configured: false })
    expect(calls).toEqual([])
  })

  it('connect stores token and returns auth metadata', async () => {
    const secrets = createMemorySecretStore()
    const calls: Array<Record<string, unknown>> = []
    registerSlackTools(tools, {
      secrets,
      http: fakeHttp({ ok: true, team: 'Acme', user: 'paul', user_id: 'U1', team_id: 'T1' }, calls),
    })

    const result = await tools.call('slack.connect', {
      account: 'test',
      token: 'xoxb-connect-test',
    }, ctx) as Record<string, unknown>

    expect(result.account).toBe('test')
    expect(result.configured).toBe(true)
    expect(result.auth).toBeDefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('auth.test')
  })

  it('connect reads a Slack token from a plain text file', async () => {
    const secrets = createMemorySecretStore()
    registerSlackTools(tools, {
      secrets,
      http: fakeHttp({ ok: true, team: 'Acme', user: 'paul', user_id: 'U1', team_id: 'T1' }),
    })

    const tokenFile = join(dir, 'slack-token.txt')
    writeFileSync(tokenFile, '  xoxb-from-file  \n')

    const result = await tools.call('slack.connect', { file: tokenFile }, ctx) as Record<string, unknown>
    expect(result.configured).toBe(true)
    expect(secrets.dump()[`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]).toBe('xoxb-from-file')
  })

  it('connect reads a Slack token from a JSON file', async () => {
    const secrets = createMemorySecretStore()
    registerSlackTools(tools, {
      secrets,
      http: fakeHttp({ ok: true, team: 'Acme', user: 'paul', user_id: 'U1', team_id: 'T1' }),
    })

    const tokenFile = join(dir, 'slack-creds.json')
    writeFileSync(tokenFile, JSON.stringify({ token: 'xoxb-json-token' }))

    const result = await tools.call('slack.connect', { file: tokenFile }, ctx) as Record<string, unknown>
    expect(result.configured).toBe(true)
    expect(secrets.dump()[`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]).toBe('xoxb-json-token')
  })

  it('connect rejects missing token file', async () => {
    registerSlackTools(tools, { secrets: createMemorySecretStore(), http: fakeHttp({ ok: true }) })
    await expect(tools.call('slack.connect', { file: join(dir, 'nonexistent.txt') }, ctx))
      .rejects.toThrow('Token file not found')
  })

  it('connect rolls back token on verification failure', async () => {
    const secrets = createMemorySecretStore()
    registerSlackTools(tools, {
      secrets,
      http: {
        async request() {
          return {
            ok: true,
            status: 200,
            async json() { return { ok: false, error: 'invalid_auth' } },
            async text() { return '{"ok":false,"error":"invalid_auth"}' },
          }
        },
      },
    })

    await expect(tools.call('slack.connect', {
      account: 'bad',
      token: 'xoxb-bad',
    }, ctx)).rejects.toThrow('Slack token verification failed')

    expect(secrets.dump()).toEqual({})
  })

  it('disconnect removes token from keychain', async () => {
    const secrets = createMemorySecretStore({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('test')}`]: 'xoxb-secret',
    })
    registerSlackTools(tools, { secrets, http: fakeHttp({ ok: true }) })

    const result = await tools.call('slack.disconnect', { account: 'test' }, ctx) as Record<string, unknown>

    expect(result.disconnected).toBe(true)
    expect(secrets.dump()).toEqual({})
  })

  it('bot status reports separate bot/app token configuration without opening Socket Mode', async () => {
    const calls: Array<Record<string, unknown>> = []
    const secrets = createMemorySecretStore({
      [`${MIM_KEYCHAIN_SERVICE}:${slackBotSecretAccount('default')}`]: 'xoxb-bot',
      [`${MIM_KEYCHAIN_SERVICE}:${slackAppSecretAccount('default')}`]: 'xapp-socket',
    })
    registerSlackTools(tools, {
      secrets,
      http: fakeHttp({ ok: true, team: 'Acme Research', user: 'mim2', user_id: 'U1', bot_id: 'B1', team_id: 'T1' }, calls),
    })

    const result = await tools.call('slack.bot.status', {}, ctx) as Record<string, unknown>

    expect(result).toEqual({
      account: 'default',
      configured: true,
      botTokenConfigured: true,
      appTokenConfigured: true,
      auth: { ok: true, team: 'Acme Research', user: 'mim2', user_id: 'U1', bot_id: 'B1', team_id: 'T1' },
    })
    expect(calls).toHaveLength(1)
    expect(String(calls[0].url)).toContain('auth.test')
  })

  it('bot connect reads bot and app tokens from JSON, verifies both, and hides the Socket Mode URL', async () => {
    const secrets = createMemorySecretStore()
    const calls: Array<Record<string, unknown>> = []
    registerSlackTools(tools, {
      secrets,
      http: {
        async request(input) {
          calls.push(input)
          if (String(input.url).includes('apps.connections.open')) {
            return {
              ok: true,
              status: 200,
              async json() { return { ok: true, url: 'wss://socket.slack.test/secret' } },
              async text() { return '{"ok":true,"url":"wss://socket.slack.test/secret"}' },
            }
          }
          return {
            ok: true,
            status: 200,
            async json() { return { ok: true, team: 'Acme Research', user: 'mim2', user_id: 'U1', bot_id: 'B1', team_id: 'T1' } },
            async text() { return '{"ok":true,"team":"Acme Research","user":"mim2","user_id":"U1","bot_id":"B1","team_id":"T1"}' },
          }
        },
      },
    })
    const tokenFile = join(dir, 'slack-bot.json')
    writeFileSync(tokenFile, JSON.stringify({
      bot_token: 'xoxb-bot',
      app_token: 'xapp-socket',
    }))

    const result = await tools.call('slack.bot.connect', { file: tokenFile }, ctx) as Record<string, unknown>

    expect(result).toEqual({
      account: 'default',
      configured: true,
      botConfigured: true,
      socketModeConfigured: true,
      auth: { ok: true, team: 'Acme Research', user: 'mim2', user_id: 'U1', bot_id: 'B1', team_id: 'T1' },
    })
    expect(JSON.stringify(result)).not.toContain('wss://')
    expect(secrets.dump()).toEqual({
      [`${MIM_KEYCHAIN_SERVICE}:${slackBotSecretAccount('default')}`]: 'xoxb-bot',
      [`${MIM_KEYCHAIN_SERVICE}:${slackAppSecretAccount('default')}`]: 'xapp-socket',
    })
    expect(calls.map(call => String(call.url))).toEqual([
      'https://slack.com/api/auth.test',
      'https://slack.com/api/apps.connections.open',
    ])
  })

  it('bot connect rejects files missing either token', async () => {
    registerSlackTools(tools, { secrets: createMemorySecretStore(), http: fakeHttp({ ok: true }) })
    const tokenFile = join(dir, 'slack-bot.json')
    writeFileSync(tokenFile, JSON.stringify({ bot_token: 'xoxb-bot' }))

    await expect(tools.call('slack.bot.connect', { file: tokenFile }, ctx))
      .rejects.toThrow('Slack bot token file must include bot_token and app_token')
  })

  it('bot connect rolls back bot tokens on verification failure', async () => {
    const secrets = createMemorySecretStore()
    registerSlackTools(tools, {
      secrets,
      http: {
        async request(input) {
          if (String(input.url).includes('apps.connections.open')) {
            return {
              ok: true,
              status: 200,
              async json() { return { ok: false, error: 'invalid_auth' } },
              async text() { return '{"ok":false,"error":"invalid_auth"}' },
            }
          }
          return {
            ok: true,
            status: 200,
            async json() { return { ok: true, team: 'Acme Research', user: 'mim2' } },
            async text() { return '{"ok":true,"team":"Acme Research","user":"mim2"}' },
          }
        },
      },
    })

    await expect(tools.call('slack.bot.connect', {
      account: 'bad',
      bot_token: 'xoxb-bad',
      app_token: 'xapp-bad',
    }, ctx)).rejects.toThrow('Slack bot verification failed')

    expect(secrets.dump()).toEqual({})
  })

  it('bot disconnect removes only bot credentials', async () => {
    const secrets = createMemorySecretStore({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]: 'xoxp-user',
      [`${MIM_KEYCHAIN_SERVICE}:${slackBotSecretAccount('default')}`]: 'xoxb-bot',
      [`${MIM_KEYCHAIN_SERVICE}:${slackAppSecretAccount('default')}`]: 'xapp-socket',
    })
    registerSlackTools(tools, { secrets, http: fakeHttp({ ok: true }) })

    const result = await tools.call('slack.bot.disconnect', {}, ctx) as Record<string, unknown>

    expect(result).toEqual({ account: 'default', disconnected: true })
    expect(secrets.dump()).toEqual({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]: 'xoxp-user',
    })
  })

  it('bot setup creates and enables a Slack routine under the bot account by default', async () => {
    const secrets = createMemorySecretStore()
    const listener = {
      refresh: vi.fn(async () => {}),
      status: vi.fn(() => ({
        implemented: true as const,
        running: true,
        live: true,
        accounts: [{
          account: 'bot',
          configured: true,
          connected: true,
          state: 'open' as const,
          botUserId: 'U1',
          teamId: 'T1',
        }],
      })),
    }
    registerSlackTools(tools, {
      secrets,
      listener,
      http: {
        async request(input) {
          if (String(input.url).includes('apps.connections.open')) {
            return {
              ok: true,
              status: 200,
              async json() { return { ok: true, url: 'wss://socket.slack.test/secret' } },
              async text() { return '{"ok":true,"url":"wss://socket.slack.test/secret"}' },
            }
          }
          return {
            ok: true,
            status: 200,
            async json() { return { ok: true, team: 'Acme Research', user: 'mim2', user_id: 'U1', bot_id: 'B1', team_id: 'T1' } },
            async text() { return '{"ok":true,"team":"Acme Research","user":"mim2","user_id":"U1","bot_id":"B1","team_id":"T1"}' },
          }
        },
      },
    })
    const tokenFile = join(dir, 'slack-bot.json')
    writeFileSync(tokenFile, JSON.stringify({
      bot_token: 'xoxb-bot',
      app_token: 'xapp-socket',
    }))

    const result = await tools.call('slack.bot.setup', {
      file: tokenFile,
      channel: 'C1',
      body: 'Answer questions using this workspace.',
    }, ctx) as Record<string, unknown>

    expect(result.account).toBe('bot')
    expect(result.configured).toBe(true)
    expect(result.live).toBe(true)
    expect(result.ready).toBe(true)
    expect(JSON.stringify(result)).not.toContain('wss://')
    expect(result.routine).toMatchObject({
      id: 'channel-bot',
      path: 'routines/channel-bot.md',
      activation: 'active',
      channel: 'C1',
      mode: 'mention',
    })
    expect(result.listener).toMatchObject({ implemented: true, running: true, connected: true, status: 'open' })
    expect(listener.refresh).toHaveBeenCalledOnce()
    expect(readFileSync(join(dir, 'routines', 'channel-bot.md'), 'utf-8')).toContain('account: bot')
    const state = JSON.parse(readFileSync(join(dir, '.mim', 'routines', 'state.json'), 'utf-8'))
    expect(state).toMatchObject({ version: 2 })
    expect(state.routines['channel-bot']).toMatchObject({ enabled: true })
    expect(secrets.dump()).toMatchObject({
      [`${MIM_KEYCHAIN_SERVICE}:${slackBotSecretAccount('bot')}`]: 'xoxb-bot',
      [`${MIM_KEYCHAIN_SERVICE}:${slackAppSecretAccount('bot')}`]: 'xapp-socket',
    })
  })

  it('bot setup updates an existing routine instead of making the user edit YAML', async () => {
    mkdirSync(join(dir, 'routines'), { recursive: true })
    writeFileSync(join(dir, 'routines', 'channel-bot.md'), [
      '---',
      'name: channel-bot',
      'trigger:',
      '  slack:',
      '    account: default',
      '    channels:',
      '      - { id: COLD, mode: mention }',
      'tools: [fs.read]',
      'approval:',
      '  allow: [fs.read]',
      '---',
      '',
      'Old prompt.',
    ].join('\n'))
    registerSlackTools(tools, { secrets: createMemorySecretStore(), http: fakeHttp({ ok: true }) })

    const result = await tools.call('slack.bot.setup', {
      account: 'bot',
      channel: 'CNEW',
      mode: 'always',
      body: 'New prompt.',
      tools: ['fs.read', 'search.files'],
    }, ctx) as Record<string, unknown>

    const text = readFileSync(join(dir, 'routines', 'channel-bot.md'), 'utf-8')
    expect(text).toContain('account: bot')
    expect(text).toContain('id: CNEW')
    expect(text).toContain('mode: always')
    expect(text).toContain('New prompt.')
    expect(result.routine).toMatchObject({
      id: 'channel-bot',
      activation: 'active',
      channel: 'CNEW',
      mode: 'always',
    })
    expect(result.credentials).toMatchObject({ configured: false, botTokenConfigured: false, appTokenConfigured: false })
  })

  it('bot setup maps user-facing capabilities to routine tools and approval grants', async () => {
    registerSlackTools(tools, { secrets: createMemorySecretStore(), http: fakeHttp({ ok: true }) })

    const result = await tools.call('slack.bot.setup', {
      account: 'bot',
      channel: 'C1',
      capabilities: ['workspace_read', 'issues_read', 'issues_write'],
    }, ctx) as Record<string, unknown>

    const text = readFileSync(join(dir, 'routines', 'channel-bot.md'), 'utf-8')
    const frontmatter = parseYaml(text.split('---')[1]) as Record<string, any>
    expect(result.capabilities).toEqual(['workspace_read', 'issues_read', 'issues_write'])
    expect(frontmatter.tools).toEqual([
      'fs.read',
      'search.files',
      'issues.list',
      'issues.get',
      'issues.create',
      'issues.update',
    ])
    expect(frontmatter.approval.allow).toEqual([
      'fs.read',
      'search.files',
      'issues.list',
      'issues.get',
    ])
  })

  it('bot check returns one readiness checklist instead of exposing runtime files', async () => {
    mkdirSync(join(dir, 'routines'), { recursive: true })
    writeFileSync(join(dir, 'routines', 'channel-bot.md'), [
      '---',
      'name: channel-bot',
      'trigger:',
      '  slack:',
      '    account: bot',
      '    channels:',
      '      - { id: C1, mode: mention }',
      'tools: [fs.read]',
      'approval:',
      '  allow: [fs.read]',
      '---',
      '',
      'Answer questions.',
    ].join('\n'))
    registerSlackTools(tools, { secrets: createMemorySecretStore(), http: fakeHttp({ ok: true }) })

    const result = await tools.call('slack.bot.check', {}, ctx) as Record<string, unknown>

    expect(result).toMatchObject({
      account: 'bot',
      channel: 'C1',
      configured: false,
      live: false,
      ready: false,
      routine: {
        exists: true,
        id: 'channel-bot',
        activation: 'review-required',
      },
      credentials: {
        configured: false,
        botTokenConfigured: false,
        appTokenConfigured: false,
      },
      listener: {
        implemented: false,
        running: false,
        connected: false,
      },
    })
    expect(result.nextActions).toEqual([
      'Run slack_bot_setup to connect credentials and enable the workspace routine.',
      'Open the Mim desktop app to run the local Slack listener.',
    ])
  })

  it('replies reads threaded messages', async () => {
    const calls: Array<Record<string, unknown>> = []
    const secrets = createMemorySecretStore({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]: 'xoxb-secret',
    })
    registerSlackTools(tools, {
      secrets,
      http: fakeHttp({ ok: true, messages: [] }, calls),
    })

    await tools.call('slack.replies', { channel: 'C1', ts: '1234.5678' }, ctx)

    expect(calls[0].url).toContain('conversations.replies')
    expect(calls[0].url).toContain('channel=C1')
    expect(calls[0].url).toContain('ts=1234.5678')
  })

  it('sends Slack messages through chat.postMessage', async () => {
    const calls: Array<Record<string, unknown>> = []
    const secrets = createMemorySecretStore({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]: 'xoxb-secret',
    })
    registerSlackTools(tools, { secrets, http: fakeHttp({ ok: true, ts: '1.2' }, calls) })

    await tools.call('slack.send', { channel: 'C1', text: 'Hello' }, ctx)

    expect(calls[0]).toMatchObject({
      url: 'https://slack.com/api/chat.postMessage',
      method: 'POST',
      body: JSON.stringify({ channel: 'C1', text: 'Hello' }),
    })
  })

  it('returns MCP state that tracks connection', async () => {
    const secrets = createMemorySecretStore()
    const state = registerSlackTools(tools, {
      secrets,
      http: fakeHttp({ ok: true, team: 'Acme', user: 'paul', user_id: 'U1', team_id: 'T1' }),
    })

    expect(state.connected).toBe(false)
    await state.refresh()
    expect(state.connected).toBe(false)

    await tools.call('slack.connect', { token: 'xoxb-test' }, ctx)
    await state.refresh()
    expect(state.connected).toBe(true)

    await tools.call('slack.disconnect', {}, ctx)
    await state.refresh()
    expect(state.connected).toBe(false)
  })
})

describe('Slack connector policy enforcement', () => {
  let dir: string
  let tools: ReturnType<typeof createToolRegistry>
  const aiCtx = { actor: 'ai' as const }
  const userCtx = { actor: 'user' as const }

  function setupWithToken() {
    const secrets = createMemorySecretStore({
      [`${MIM_KEYCHAIN_SERVICE}:${slackSecretAccount('default')}`]: 'xoxb-secret',
    })
    const calls: Array<Record<string, unknown>> = []
    registerSlackTools(tools, {
      secrets,
      http: fakeHttp({ ok: true, channels: [], messages: { matches: [] } }, calls),
    })
    return calls
  }

  function writePolicy(policy: Record<string, unknown>) {
    const enabled: string[] = []
    if (policy.aiEnabled) enabled.push('slack.search', 'slack.history', 'slack.channels', 'slack.replies', 'slack.users')
    if (policy.aiEnabled && policy.sendEnabled) enabled.push('slack.send')
    if (policy.aiEnabled && policy.privateChannels) enabled.push('slack.privateChannels')
    if (policy.aiEnabled && policy.directMessages) enabled.push('slack.dms', 'slack.directMessages')
    mkdirSync(join(dir, '.mim'), { recursive: true })
    writeFileSync(join(dir, '.mim', 'settings.json'), JSON.stringify({
      tools: { enabled, disabled: [] },
    }))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-slack-policy-'))
    tools = createToolRegistry(createTraceLog())
    tools.setWorkspacePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('blocks AI actor when aiEnabled is false (default)', async () => {
    setupWithToken()
    await expect(tools.call('slack.channels', {}, aiCtx))
      .rejects.toThrow('Slack AI access is disabled')
  })

  it('allows AI actor when aiEnabled is true', async () => {
    writePolicy({ aiEnabled: true })
    setupWithToken()
    await expect(tools.call('slack.channels', {}, aiCtx)).resolves.toBeDefined()
  })

  it('allows user actor regardless of policy', async () => {
    // Default policy has everything disabled, but user actor bypasses
    setupWithToken()
    await expect(tools.call('slack.channels', {}, userCtx)).resolves.toBeDefined()
  })

  it('blocks AI send when sendEnabled is false', async () => {
    writePolicy({ aiEnabled: true, sendEnabled: false })
    setupWithToken()
    await expect(tools.call('slack.send', { channel: 'C1', text: 'hi' }, aiCtx))
      .rejects.toThrow('Slack send is disabled')
  })

  it('allows AI send when sendEnabled is true', async () => {
    writePolicy({ aiEnabled: true, sendEnabled: true })
    setupWithToken()
    await expect(tools.call('slack.send', { channel: 'C1', text: 'hi' }, aiCtx))
      .resolves.toBeDefined()
  })

  it('blocks AI DM access when directMessages is false', async () => {
    writePolicy({ aiEnabled: true, directMessages: false })
    setupWithToken()
    await expect(tools.call('slack.dms', {}, aiCtx))
      .rejects.toThrow('Slack DM access is disabled')
  })

  it('allows AI DM access when directMessages is true', async () => {
    writePolicy({ aiEnabled: true, directMessages: true })
    setupWithToken()
    await expect(tools.call('slack.dms', {}, aiCtx)).resolves.toBeDefined()
  })

  it('filters channel types for AI based on privateChannels policy', async () => {
    writePolicy({ aiEnabled: true, privateChannels: false })
    const calls = setupWithToken()
    await tools.call('slack.channels', {}, aiCtx)
    const url = calls[0]?.url as string
    expect(url).toContain('types=public_channel')
    expect(url).not.toContain('private_channel')
  })

  it('includes private channels when policy allows', async () => {
    writePolicy({ aiEnabled: true, privateChannels: true })
    const calls = setupWithToken()
    await tools.call('slack.channels', {}, aiCtx)
    const url = calls[0]?.url as string
    expect(url).toContain('private_channel')
  })

  it('blocks AI search when aiEnabled is false', async () => {
    setupWithToken()
    await expect(tools.call('slack.search', { query: 'test' }, aiCtx))
      .rejects.toThrow('Slack AI access is disabled')
  })

  it('blocks AI history when aiEnabled is false', async () => {
    setupWithToken()
    await expect(tools.call('slack.history', { channel: 'C1' }, aiCtx))
      .rejects.toThrow('Slack AI access is disabled')
  })
})
