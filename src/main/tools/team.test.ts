import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTraceLog } from '@main/trace/trace.js'
import { createToolRegistry } from '@main/tools/registry.js'
import { registerTeamTools } from '@main/tools/team.js'

const ctx = { actor: 'user' as const }

describe('Team tools', () => {
  let tools: ReturnType<typeof createToolRegistry>
  let source: {
    status: ReturnType<typeof vi.fn>
    connect: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    check: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  let emit: ReturnType<typeof vi.fn>
  let onChanged: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tools = createToolRegistry(createTraceLog())
    source = {
      status: vi.fn(async () => ({ state: 'disconnected' })),
      connect: vi.fn(async (repository: string) => ({ state: 'synced', repository })),
      open: vi.fn(async () => ({ name: 'Acme Research', root: '/home/.mim/team' })),
      check: vi.fn(async () => ({
        state: 'needs-sync',
        update: {
          state: 'available',
          changes: [{ kind: 'app', id: 'knowledge', name: 'Knowledge', action: 'updated' }],
        },
      })),
      update: vi.fn(async () => ({
        state: 'synced',
        update: { state: 'current', changes: [], recentChanges: [] },
      })),
    }
    emit = vi.fn()
    onChanged = vi.fn(async () => undefined)
    registerTeamTools(tools, { source, emit, onChanged })
  })

  it('registers the single-source status, connect, open, check, and update surface', () => {
    expect(tools.list().map(tool => tool.name)).toEqual([
      'team.status',
      'team.connect',
      'team.open',
      'team.check',
      'team.update',
    ])
    for (const tool of tools.list()) expect(tool.inputSchema).toBeDefined()
  })

  it('routes every action through the same Team source resolver', async () => {
    await expect(tools.call('team.status', {}, ctx)).resolves.toEqual({ state: 'disconnected' })
    await expect(tools.call('team.connect', { repository: '/repos/team.git' }, ctx))
      .resolves.toEqual({ state: 'synced', repository: '/repos/team.git' })
    await expect(tools.call('team.open', {}, ctx))
      .resolves.toEqual({ team: { name: 'Acme Research', root: '/home/.mim/team' } })
    await expect(tools.call('team.check', {}, ctx)).resolves.toMatchObject({
      update: { state: 'available' },
    })
    await tools.call('team.check', {}, ctx)
    await expect(tools.call('team.update', {}, ctx)).resolves.toMatchObject({
      update: { state: 'current' },
    })

    expect(source.connect).toHaveBeenCalledWith('/repos/team.git')
    expect(source.status).toHaveBeenCalledOnce()
    expect(source.open).toHaveBeenCalledOnce()
    expect(source.check).toHaveBeenCalledTimes(2)
    expect(source.update).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenNthCalledWith(1, 'team:changed')
    expect(emit).toHaveBeenNthCalledWith(2, 'team:update-available', {
      changes: [{ kind: 'app', id: 'knowledge', name: 'Knowledge', action: 'updated' }],
      teamName: undefined,
    })
    expect(emit).toHaveBeenNthCalledWith(3, 'team:changed')
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty repository before reaching the resolver', async () => {
    await expect(tools.call('team.connect', { repository: '   ' }, ctx))
      .rejects.toThrow('repository')
    expect(source.connect).not.toHaveBeenCalled()
  })

  it('checks quietly when the Team screen is already open', async () => {
    await tools.call('team.check', { announce: false }, ctx)

    expect(emit).not.toHaveBeenCalled()
  })
})
