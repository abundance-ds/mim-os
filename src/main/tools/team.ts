import type { TeamSource } from '@main/team/teamSource.js'
import type { ToolRegistry } from '@main/tools/registry.js'

export interface TeamToolOptions {
  source: TeamSource
  emit?: (channel: string, payload?: unknown) => void
  onChanged?: () => void | Promise<void>
}

export function registerTeamTools(tools: ToolRegistry, options: TeamToolOptions): void {
  let announcedRevision: string | undefined
  tools.register({
    name: 'team.status',
    description: 'Read the optional Team connection, contribution summary, and update state.',
    inputSchema: objectSchema({}),
    execute: async () => options.source.status(),
  })

  tools.register({
    name: 'team.connect',
    description: 'Connect one company Team from its repository link using the computer’s existing Git access.',
    inputSchema: objectSchema({
      repository: { type: 'string', description: 'Credential-free HTTPS, SSH, or local Git repository location' },
    }, ['repository']),
    execute: async (params) => {
      const repository = requireString(params, 'repository')
      const result = await options.source.connect(repository)
      await options.onChanged?.()
      options.emit?.('team:changed')
      return result
    },
  })

  tools.register({
    name: 'team.open',
    description: 'Open the connected Team and resolve its contribution folders.',
    inputSchema: objectSchema({}),
    execute: async () => ({ team: await options.source.open() }),
  })

  tools.register({
    name: 'team.check',
    description: 'Check whether the connected Team has an update without changing the installed Team content.',
    inputSchema: objectSchema({
      announce: { type: 'boolean', description: 'Notify the desktop when a new Team release is found' },
    }),
    execute: async (params) => {
      const result = await options.source.check()
      const availableRevision = result.update.availableRevision ?? 'available'
      if (
        params.announce !== false
        && result.update.state === 'available'
        && availableRevision !== announcedRevision
      ) {
        announcedRevision = availableRevision
        options.emit?.('team:update-available', {
          teamName: result.team?.name,
          changes: result.update.changes,
        })
      }
      if (result.update.state === 'current') announcedRevision = undefined
      return result
    },
  })

  tools.register({
    name: 'team.update',
    description: 'Install the available connected Team update as one validated release.',
    inputSchema: objectSchema({}),
    execute: async () => {
      const result = await options.source.update()
      announcedRevision = undefined
      await options.onChanged?.()
      options.emit?.('team:changed')
      return result
    },
  })
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required }
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}
