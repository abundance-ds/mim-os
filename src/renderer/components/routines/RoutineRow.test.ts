// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import RoutineRow from './RoutineRow.vue'
import type { RoutineDefinition } from '../../stores/routines.js'

function routine(overrides: Partial<RoutineDefinition> = {}): RoutineDefinition {
  return {
    id: 'pulse',
    path: 'routines/pulse.md',
    origin: 'project',
    name: 'pulse',
    description: 'Check the project pulse.',
    trigger: { every: '4h' },
    tools: ['fs.read', 'fs.write'],
    approvalAllow: ['fs.read'],
    body: 'Check the project pulse.',
    authorityHash: 'authority',
    revision: 'revision',
    activation: 'active',
    lastSuccessAt: '2026-07-14T09:00:00.000Z',
    nextRunAt: '2026-07-14T13:00:00.000Z',
    ...overrides,
  }
}

describe('RoutineRow', () => {
  it('renders automation health and exposes run, edit, and disable actions', async () => {
    const root = document.createElement('div')
    const onRun = vi.fn()
    const onEdit = vi.fn()
    const onDisable = vi.fn()
    const app = createApp(RoutineRow, {
      routine: routine(),
      onRun,
      onEdit,
      onDisable,
    })
    app.use(createPinia())
    app.mount(root)

    expect(root.textContent).toContain('Check the project pulse.')
    expect(root.textContent).toContain('Every 4 hours')
    expect(root.textContent).toContain('2 tools · 1 allowed without asking')
    expect(root.textContent).toContain('Completed')
    expect(root.textContent).toContain('Next')
    expect(root.textContent).toContain('Project')

    root.querySelector<HTMLButtonElement>('[data-testid="routine-run"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-testid="routine-edit"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-testid="routine-automatic"]')?.click()
    await nextTick()

    expect(onRun).toHaveBeenCalledOnce()
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onDisable).toHaveBeenCalledOnce()
    app.unmount()
  })

  it('shows the actual Team source and the local machine that owns automatic runs', () => {
    const root = document.createElement('div')
    const app = createApp(RoutineRow, {
      routine: routine({ origin: 'team', owner: 'always-on-mac' }),
      sourceLabel: 'Acme Research',
    })
    app.use(createPinia())
    app.mount(root)

    expect(root.textContent).toContain('Acme Research')
    expect(root.textContent).toContain('Runs on always-on-mac')
    app.unmount()
  })

  it('routes review-required activation through review instead of enabling silently', async () => {
    const root = document.createElement('div')
    const onReview = vi.fn()
    const app = createApp(RoutineRow, {
      routine: routine({ activation: 'review-required' }),
      onReview,
    })
    app.use(createPinia())
    app.mount(root)

    root.querySelector<HTMLButtonElement>('[data-testid="routine-automatic"]')?.click()
    await nextTick()

    expect(root.textContent).toContain('Review required')
    expect(onReview).toHaveBeenCalledOnce()
    app.unmount()
  })
})
