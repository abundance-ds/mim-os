// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ChatMessage from './ChatMessage.vue'

async function flushUi() {
  await Promise.resolve()
  await nextTick()
}

let mounted: ReturnType<typeof mountMessage> | null = null

function mountMessage(props: Record<string, unknown>) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(ChatMessage, props)
  app.mount(root)
  return { app, root }
}

describe('ChatMessage', () => {
  afterEach(() => {
    mounted?.app.unmount()
    mounted?.root.remove()
    mounted = null
    vi.restoreAllMocks()
  })

  it('injects a trusted copy button into code blocks after sanitization', async () => {
    mounted = mountMessage({
      isLastAssistant: true,
      chatStatus: 'ready',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Run this:\n\n```js\nconsole.log(1)\n```\n' },
        ],
      },
    })
    await flushUi()

    // The button must come from injectCopyButtons (trusted DOM), not from the
    // sanitized markdown HTML — the sanitizer strips <button> from model output.
    const btn = mounted.root.querySelector('.cm-code-header .cm-code-copy')
    expect(btn).toBeTruthy()
    expect(btn!.textContent).toBe('Copy')
  })

  it('leaves an active assistant turn fully visible', async () => {
    mounted = mountMessage({
      isLastAssistant: true,
      isActiveAssistant: true,
      chatStatus: 'streaming',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Reading the file...' },
          { type: 'tool-fs_read', state: 'output-available', input: { path: 'README.md' }, output: { ok: true } },
          { type: 'text', text: 'Final answer.' },
        ],
      },
    })
    await flushUi()

    expect(mounted.root.textContent).toContain('Reading the file')
    expect(mounted.root.textContent).toContain('fs_read')
    expect(mounted.root.textContent).toContain('Final answer')
    expect(mounted.root.textContent).not.toContain('Details')
  })

  it('renders skill activation as a first-class line with expandable instructions', async () => {
    const openFile = vi.fn()
    mounted = mountMessage({
      onOpenFile: openFile,
      isLastAssistant: true,
      isActiveAssistant: true,
      chatStatus: 'streaming',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-skill',
            state: 'output-available',
            input: { name: 'issue-work' },
            output: {
              skill: {
                name: 'issue-work',
                description: 'Work with Mim issues.',
                body: '# Issue Work\n\nIssues are durable.',
                tools: ['issues.list'],
                source: 'team',
                sourceName: 'Acme Research',
                editorPath: '.mim/team/skills/issue-work/SKILL.md',
              },
            },
          },
          { type: 'text', text: 'Done.' },
        ],
      },
    })
    await flushUi()

    expect(mounted.root.textContent).toContain('Using skill')
    expect(mounted.root.textContent).toContain('issue-work')
    expect(mounted.root.textContent).toContain('Acme Research')
    // Instructions are collapsed until expanded.
    expect(mounted.root.textContent).not.toContain('Issues are durable')

    const toggle = mounted.root.querySelector<HTMLButtonElement>('button[title="Show skill instructions"]')!
    expect(toggle).toBeTruthy()
    toggle.click()
    await flushUi()

    expect(mounted.root.textContent).toContain('Issues are durable')

    mounted.root.querySelector<HTMLButtonElement>('button[title="Open skill"]')?.click()
    expect(openFile).toHaveBeenCalledWith('.mim/team/skills/issue-work/SKILL.md')
  })

  it('collapses finished assistant details and expands them on click', async () => {
    mounted = mountMessage({
      isLastAssistant: true,
      chatStatus: 'ready',
      message: {
        id: 'a1',
        role: 'assistant',
        metadata: { mim: { turnElapsedMs: 72_000 } },
        parts: [
          { type: 'text', text: 'Reading the file...' },
          { type: 'tool-fs_read', state: 'output-available', input: { path: 'README.md' }, output: { ok: true } },
          { type: 'text', text: 'Final answer.' },
        ],
      },
    })
    await flushUi()

    expect(mounted.root.textContent).not.toContain('Reading the file')
    expect(mounted.root.textContent).not.toContain('fs_read')
    expect(mounted.root.textContent).toContain('Final answer')
    expect(mounted.root.textContent!.indexOf('Show Details')).toBeLessThan(mounted.root.textContent!.indexOf('Final answer'))
    const collapsedButton = mounted.root.querySelector<HTMLButtonElement>('button[title="Show details"]')!
    expect(collapsedButton.getAttribute('aria-label')).toBe('Show Details · checked README.md · 1 action · 1m 12s')
    expect(collapsedButton.className).toContain('text-left')
    expect(collapsedButton.className).toContain('max-w-full')
    expect(collapsedButton.querySelector('[class*="overflow-wrap:anywhere"]')).toBeTruthy()

    collapsedButton.click()
    await flushUi()

    expect(mounted.root.textContent).toContain('Reading the file')
    expect(mounted.root.textContent).toContain('fs_read')
    expect(mounted.root.textContent).toContain('Final answer')
    expect(mounted.root.textContent).toContain('Hide Details')
    expect(mounted.root.textContent!.indexOf('Reading the file')).toBeLessThan(mounted.root.textContent!.indexOf('Final answer'))
  })

  it('keeps a completed last assistant turn collapsed while the next response is starting', async () => {
    mounted = mountMessage({
      isLastAssistant: true,
      isActiveAssistant: false,
      chatStatus: 'submitted',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Earlier progress.' },
          { type: 'text', text: 'Earlier final answer.' },
        ],
      },
    })
    await flushUi()

    expect(mounted.root.textContent).not.toContain('Earlier progress')
    expect(mounted.root.textContent).toContain('Earlier final answer')
    expect(mounted.root.querySelector('button')?.getAttribute('aria-label')).toBe('Show Details')
  })

  it('renders context filenames without exposing hidden content', () => {
    mounted = mountMessage({
      message: {
        id: 'm1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Please review this' },
          {
            type: 'data-context',
            data: {
              filename: 'private-notes.md',
              mediaType: 'text/markdown',
              content: 'hidden phrase must not render',
            },
          },
        ],
      },
    })

    const { root } = mounted
    expect(root.textContent).toContain('Please review this')
    expect(root.textContent).toContain('private-notes.md')
    expect(root.textContent).not.toContain('hidden phrase must not render')
  })

  it('shows interrupted marker on a turn persisted mid-flight', async () => {
    mounted = mountMessage({
      isLastAssistant: true,
      isActiveAssistant: false,
      chatStatus: 'ready',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Starting work...' },
          { type: 'tool-fs_read', state: 'partial', input: { path: 'file.md' } },
        ],
      },
    })
    await flushUi()
    expect(mounted.root.textContent).toContain('interrupted')
    expect(mounted.root.textContent).toContain('incomplete')
  })

  it('does not show interrupted marker on a completed turn', async () => {
    mounted = mountMessage({
      isLastAssistant: true,
      isActiveAssistant: false,
      chatStatus: 'ready',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'tool-fs_read', state: 'output-available', input: { path: 'file.md' }, output: { ok: true } },
          { type: 'text', text: 'Done.' },
        ],
      },
    })
    await flushUi()
    expect(mounted.root.textContent).not.toContain('interrupted')
  })

  it('does not show interrupted marker while actively streaming', async () => {
    mounted = mountMessage({
      isLastAssistant: true,
      isActiveAssistant: true,
      chatStatus: 'streaming',
      message: {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'tool-fs_read', state: 'partial', input: { path: 'file.md' } },
        ],
      },
    })
    await flushUi()
    expect(mounted.root.textContent).not.toContain('interrupted')
  })

  it('copies only visible user text', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    mounted = mountMessage({
      message: {
        id: 'm1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Visible request' },
          {
            type: 'data-context',
            data: {
              filename: 'notes.md',
              mediaType: 'text/markdown',
              content: 'secret attachment body',
            },
          },
        ],
      },
    })

    const { root } = mounted
    root.querySelector<HTMLButtonElement>('button[title="Copy"]')?.click()
    await nextTick()

    expect(writeText).toHaveBeenCalledWith('Visible request')
  })
})
