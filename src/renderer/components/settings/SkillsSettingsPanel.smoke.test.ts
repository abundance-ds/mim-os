// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SkillsSettingsPanel from './SkillsSettingsPanel.vue'

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

function click(target: Element | null) {
  expect(target).toBeTruthy()
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

async function input(selector: string, value: string) {
  const el = document.body.querySelector<HTMLInputElement>(selector)
  expect(el).toBeTruthy()
  el!.value = value
  el!.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

describe('SkillsSettingsPanel', () => {
  let root: HTMLElement
  let app: ReturnType<typeof createApp> | null
  let call: ReturnType<typeof vi.fn>
  let skills: Array<Record<string, unknown>>

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
    setActivePinia(createPinia())
    app = null
    skills = [
      {
        id: 'issue-work',
        name: 'issue-work',
        description: 'Use when working with Mim issues.',
        source: 'personal',
        editorPath: '.mim/origins/you/skills/issue-work/SKILL.md',
        enabled: true,
        shadows: [{ source: 'mim' }],
      },
      {
        id: 'team-review',
        name: 'team-review',
        description: 'Review Team work.',
        source: 'team',
        sourceName: 'Acme Research',
        editorPath: '.mim/team/skills/team-review/SKILL.md',
        enabled: true,
        shadows: [],
      },
      {
        id: 'builtin-note',
        name: 'builtin-note',
        description: 'Use built-in defaults.',
        source: 'mim',
        editorPath: '.mim/origins/mim/skills/builtin-note/SKILL.md',
        enabled: true,
        shadows: [],
      },
    ]
    call = vi.fn(async (tool: string, params?: Record<string, unknown>) => {
      if (tool === 'skill.list') return { skills: skills.map(skill => ({ ...skill })), diagnostics: [] }
      if (tool === 'workspace.info') return { name: 'Alpha' }
      if (tool === 'team.status') return { connected: true, team: { name: 'Acme Research' } }
      if (tool === 'skill.setDisabled') {
        const item = skills.find(skill => skill.name === params?.name)
        if (item) item.enabled = params?.disabled !== true
        return {}
      }
      if (tool === 'skill.create') {
        const name = params?.name as string
        const destination = params?.destination as string
        const editorPath = destination === 'team'
          ? `.mim/team/skills/${name}/SKILL.md`
          : destination === 'project'
            ? `skills/${name}/SKILL.md`
            : `.mim/origins/you/skills/${name}/SKILL.md`
        skills.push({
          id: name,
          name,
          description: params?.description,
          source: destination,
          editorPath,
          enabled: true,
          shadows: [],
        })
        return { skill: { editorPath } }
      }
      if (tool === 'editor.open') return { opened: params?.path }
      return {}
    })
    Object.defineProperty(window, 'kernel', {
      configurable: true,
      value: { call, on: vi.fn(), off: vi.fn() },
    })
  })

  afterEach(() => {
    app?.unmount()
    root.remove()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function mount() {
    const pinia = createPinia()
    setActivePinia(pinia)
    app = createApp(SkillsSettingsPanel)
    app.use(pinia)
    app.mount(root)
  }

  it('renders one searchable flat list with actual origin labels', async () => {
    mount()
    await flushUi()

    expect(call).toHaveBeenCalledWith('skill.list', { detailed: true })
    expect(root.textContent).toContain('issue-work')
    expect(root.textContent).toContain('You')
    expect(root.textContent).toContain('Acme Research')
    expect(root.textContent).toContain('Mim')
    expect(root.textContent).not.toContain('Add a source')

    await input('[data-testid="skill-search"]', 'team')
    expect(root.textContent).toContain('team-review')
    expect(root.textContent).not.toContain('builtin-note')
  })

  it('opens every origin in the normal editor and toggles per-user state', async () => {
    mount()
    await flushUi()

    click(root.querySelector('[data-testid="skill-open-team-review"]'))
    click(root.querySelector('[aria-label="issue-work enabled"]'))
    await flushUi()

    expect(call).toHaveBeenCalledWith('editor.open', {
      path: '.mim/team/skills/team-review/SKILL.md',
    })
    expect(call).toHaveBeenCalledWith('skill.setDisabled', {
      name: 'issue-work',
      disabled: true,
    })
  })

  it('creates in a selected destination and opens the new SKILL.md', async () => {
    mount()
    await flushUi()

    click(root.querySelector('[data-testid="skill-new-open"]'))
    await flushUi()
    await input('[data-testid="skill-new-name"]', 'research-plan')
    await input('[data-testid="skill-new-description"]', 'Plan a research project.')
    click(document.body.querySelector('[data-testid="skill-destination-team"]'))
    await flushUi()
    click(document.body.querySelector('[data-testid="skill-create"]'))
    await flushUi()

    expect(call).toHaveBeenCalledWith('skill.create', {
      name: 'research-plan',
      description: 'Plan a research project.',
      destination: 'team',
    })
    expect(call).toHaveBeenCalledWith('editor.open', {
      path: '.mim/team/skills/research-plan/SKILL.md',
    })
  })
})
