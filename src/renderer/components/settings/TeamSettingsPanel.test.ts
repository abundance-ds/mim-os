// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import TeamSettingsPanel from './TeamSettingsPanel.vue'

interface HarnessOptions {
  status?: Record<string, unknown>
  checked?: Record<string, unknown>
  updated?: Record<string, unknown>
  checkError?: Error
}

describe('TeamSettingsPanel', () => {
  it('checks quietly and shows a calm current state without sync language', async () => {
    const { app, call, root } = await mountPanel({
      status: connectedStatus(),
      checked: connectedStatus(),
    })

    expect(root.textContent).toContain('Shoulders')
    expect(root.textContent).toContain('Up to date')
    expect(root.textContent).not.toContain('Sync')
    expect(root.textContent).not.toContain('automatically')
    expect(call.mock.calls).toEqual([
      ['team.status'],
      ['team.check', { announce: false }],
    ])
    expect(root.querySelector('[data-testid="team-update"]')).toBeNull()
    app.unmount()
  })

  it('explains an available release and installs it with one Update action', async () => {
    const available = connectedStatus({
      state: 'available',
      checkedAt: '2026-07-24T10:00:00.000Z',
      changes: [
        {
          kind: 'app',
          id: 'knowledge',
          name: 'Knowledge',
          action: 'updated',
          currentVersion: '0.4.0',
          nextVersion: '0.4.1',
        },
        {
          kind: 'skill',
          id: 'build-app',
          name: 'Build App',
          action: 'updated',
          currentVersion: '1.0.0',
          nextVersion: '1.0.1',
        },
      ],
    })
    const { app, call, root } = await mountPanel({
      status: connectedStatus(),
      checked: available,
      updated: connectedStatus({
        state: 'current',
        appliedAt: '2026-07-24T10:05:00.000Z',
        changes: [],
      }),
    })

    expect(root.textContent).toContain('Update available')
    expect(root.textContent).toContain('Knowledge')
    expect(root.textContent).toContain('App updated')
    expect(root.textContent).toContain('Build App')
    expect(root.textContent).toContain('Skill updated')

    root.querySelector<HTMLButtonElement>('[data-testid="team-update"]')?.click()
    await Promise.resolve()
    await nextTick()

    expect(call).toHaveBeenCalledWith('team.update')
    expect(root.textContent).toContain('Updated')
    app.unmount()
  })

  it('calls out expanded app access before the Team update is chosen', async () => {
    const { app, root } = await mountPanel({
      status: connectedStatus(),
      checked: connectedStatus({
        state: 'available',
        changes: [{
          kind: 'app',
          id: 'knowledge',
          name: 'Knowledge',
          action: 'updated',
          accessChanged: true,
        }],
      }),
    })

    expect(root.textContent).toContain('Review access')
    expect(root.textContent).toContain('This app asks for new access')
    app.unmount()
  })

  it('presents an optional Team as a simple company link', async () => {
    const { app, root } = await mountPanel({
      status: {
        state: 'disconnected',
        repository: null,
        message: 'Connect a Team.',
        team: null,
        update: { state: 'unknown', changes: [], checkedAt: null },
        git: {
          available: true,
          installAction: null,
          lfsRequired: false,
          lfsAvailable: null,
          lfsInstallAction: null,
        },
      },
    })

    expect(root.textContent).toContain('Connect your Team')
    expect(root.textContent).toContain('company’s apps, skills, routines, files, and guidance')
    expect(root.textContent).toContain('Team link')
    expect(root.textContent).toContain('Connect Team')
    expect(root.textContent).not.toContain('Team source')
    app.unmount()
  })

  it('restores a configured Team checkout instead of asking the person to connect twice', async () => {
    const { app, call, root } = await mountPanel({
      status: {
        state: 'not-cloned',
        repository: 'git@github.com:shoulders-ai/team.git',
        message: 'The local Team copy is missing.',
        team: null,
        update: { state: 'unknown', changes: [], checkedAt: null },
      },
      checked: connectedStatus(),
    })

    expect(call.mock.calls.map(args => args[0])).toEqual(['team.status', 'team.check'])
    expect(root.textContent).toContain('Shoulders')
    expect(root.textContent).not.toContain('Connect your Team')
    app.unmount()
  })

  it('offers a plain retry when a configured Team cannot be restored yet', async () => {
    const { app, root } = await mountPanel({
      status: {
        state: 'not-cloned',
        repository: 'git@github.com:shoulders-ai/team.git',
        message: 'Restoring the local Team copy.',
        team: null,
        update: { state: 'unknown', changes: [], checkedAt: null },
      },
      checkError: new Error('You appear to be offline'),
    })

    expect(root.textContent).toContain('Needs attention')
    expect(root.textContent).toContain('You appear to be offline')
    expect(root.textContent).toContain('Try again')
    expect(root.textContent).not.toContain('Connect your Team')
    app.unmount()
  })

  it('keeps the folder and repository behind developer details', async () => {
    const revealInFinder = vi.fn()
    const { app, root } = await mountPanel({
      status: connectedStatus(),
      checked: connectedStatus(),
    }, revealInFinder)

    expect(root.querySelector('details')?.textContent).toContain('Developer details')
    expect(root.querySelector('details')?.textContent).toContain('git@github.com:shoulders-ai/team.git')
    root.querySelector<HTMLButtonElement>('[data-testid="team-open"]')?.click()
    await Promise.resolve()
    expect(revealInFinder).toHaveBeenCalledWith('/tmp/team')
    app.unmount()
  })
})

function connectedStatus(update: Record<string, unknown> = {
  state: 'current',
  changes: [],
  checkedAt: '2026-07-24T10:00:00.000Z',
}) {
  return {
    state: 'synced',
    repository: 'git@github.com:shoulders-ai/team.git',
    message: 'Up to date.',
    team: {
      name: 'Shoulders',
      root: '/tmp/team',
      contributions: { files: 3, skills: 2, apps: 1, routines: 4, instructions: true },
    },
    update,
    git: {
      available: true,
      installAction: null,
      lfsRequired: false,
      lfsAvailable: null,
      lfsInstallAction: null,
    },
  }
}

async function mountPanel(options: HarnessOptions, revealInFinder = vi.fn()) {
  const call = vi.fn(async (tool: string) => {
    if (tool === 'team.status') return options.status
    if (tool === 'team.check') {
      if (options.checkError) throw options.checkError
      return options.checked ?? options.status
    }
    if (tool === 'team.update') return options.updated ?? options.checked ?? options.status
    if (tool === 'team.open') return { team: { root: '/tmp/team' } }
    return {}
  })
  Object.defineProperty(window, 'kernel', {
    configurable: true,
    value: { call, revealInFinder, on: vi.fn(), off: vi.fn() },
  })
  const root = document.createElement('div')
  const app = createApp(TeamSettingsPanel)
  app.mount(root)
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
  return { app, call, root }
}
