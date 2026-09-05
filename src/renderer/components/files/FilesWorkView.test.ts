// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, h, nextTick, ref } from 'vue'
import FilesWorkView from './FilesWorkView.vue'

const indexFiles = ref<Array<{
  path: string
  name: string
  dir: string
  size?: number
  modifiedAt?: string
  createdAt?: string
  lastChangedBy?: string
}>>([])
const indexTruncated = ref(false)
const loadSpy = vi.fn()
const refreshSpy = vi.fn()

vi.mock('../../services/workspaceFileIndex.js', () => ({
  useWorkspaceFileIndex: () => ({
    files: indexFiles,
    truncated: indexTruncated,
    loaded: ref(true),
    load: loadSpy,
    refresh: refreshSpy,
  }),
}))

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function waitForContentSearch() {
  await vi.advanceTimersByTimeAsync(220)
  await flushUi()
}

function mountFiles(props = {}, handlers: Record<string, unknown> = {}) {
  const appRoot = document.createElement('div')
  document.body.appendChild(appRoot)
  const app = createApp(FilesWorkView, {
    active: true,
    recentFiles: [],
    ...props,
    ...handlers,
  })
  app.use(createPinia())
  app.mount(appRoot)
  return { app, root: appRoot }
}

function mountReactiveFiles(
  props: {
    active?: ReturnType<typeof ref<boolean>>
    refreshKey?: ReturnType<typeof ref<number>>
  },
  handlers: Record<string, unknown> = {},
) {
  const appRoot = document.createElement('div')
  document.body.appendChild(appRoot)
  const app = createApp({
    setup() {
      return () => h(FilesWorkView, {
        active: props.active?.value ?? true,
        refreshKey: props.refreshKey?.value,
        recentFiles: [],
        ...handlers,
      })
    },
  })
  app.use(createPinia())
  app.mount(appRoot)
  return { app, root: appRoot }
}

function rowButtons(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="files-row"]'))
}

function modeButton(root: HTMLElement, label: string) {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find(item =>
      item.textContent?.trim() === label
      || item.title === label
      || item.getAttribute('aria-label') === label
    )
  if (!button) throw new Error(`Missing button ${label}`)
  return button
}

function input(root: HTMLElement) {
  return root.querySelector<HTMLInputElement>('input[placeholder="Search files"]')!
}

async function type(root: HTMLElement, value: string) {
  const el = input(root)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

function dataTransfer() {
  const values = new Map<string, string>()
  const transfer = {
    types: [] as string[],
    files: [],
    effectAllowed: '',
    dropEffect: '',
    setData(type: string, value: string) {
      values.set(type, value)
      transfer.types = Array.from(values.keys())
    },
    getData(type: string) {
      return values.get(type) ?? ''
    },
  }
  return transfer
}

describe('FilesWorkView', () => {
  let mounted: ReturnType<typeof mountFiles> | null = null
  let call: ReturnType<typeof vi.fn>

  beforeEach(() => {
    indexFiles.value = [
      {
        path: 'docs/design-system.md',
        name: 'design-system.md',
        dir: 'docs',
        size: 1200,
        modifiedAt: '2026-06-01T09:30:00.000Z',
        createdAt: '2026-01-18T10:00:00.000Z',
        lastChangedBy: 'Ada',
      },
      {
        path: 'docs/proposal.docx',
        name: 'proposal.docx',
        dir: 'docs',
        size: 48000,
        modifiedAt: '2026-05-31T15:00:00.000Z',
        createdAt: '2026-05-20T08:00:00.000Z',
        lastChangedBy: 'Ben',
      },
      {
        path: 'src/renderer/App.vue',
        name: 'App.vue',
        dir: 'src/renderer',
        size: 7200,
        modifiedAt: '2026-05-30T10:00:00.000Z',
        createdAt: '2026-03-01T08:00:00.000Z',
        lastChangedBy: 'Clara',
      },
    ]
    indexTruncated.value = false
    loadSpy.mockClear()
    refreshSpy.mockClear()
    call = vi.fn(async (tool: string, params?: Record<string, unknown>) => {
      if (tool === 'fs.list' && params?.path === '.') {
        return {
          entries: [
            {
              path: 'docs',
              name: 'docs',
              type: 'directory',
              modifiedAt: '2026-06-01T08:00:00.000Z',
              createdAt: '2026-01-18T09:00:00.000Z',
              lastChangedBy: 'Ada',
            },
            {
              path: 'README.md',
              name: 'README.md',
              type: 'file',
              size: 9000,
              modifiedAt: '2026-06-01T07:30:00.000Z',
              createdAt: '2026-01-18T09:00:00.000Z',
              lastChangedBy: 'Ada',
            },
          ],
          truncated: false,
        }
      }
      if (tool === 'fs.list' && params?.path === 'docs') {
        return {
          entries: [
            {
              path: 'docs/proposal.docx',
              name: 'proposal.docx',
              type: 'file',
              size: 48000,
              modifiedAt: '2026-05-31T15:00:00.000Z',
              createdAt: '2026-05-20T08:00:00.000Z',
              lastChangedBy: 'Ben',
            },
            {
              path: 'docs/design-system.md',
              name: 'design-system.md',
              type: 'file',
              size: 1200,
              modifiedAt: '2026-06-01T09:30:00.000Z',
              createdAt: '2026-01-18T10:00:00.000Z',
              lastChangedBy: 'Ada',
            },
          ],
          truncated: false,
        }
      }
      if (tool === 'search.files' && params?.query === 'command palette') {
        return {
          results: [
            {
              path: 'src/renderer/App.vue',
              line: 42,
              snippet: 'Open the command palette from the application shell.',
            },
          ],
        }
      }
      if (tool === 'search.files') return { results: [] }
      if (tool === 'awareness.recent') {
        return {
          changes: [
            {
              id: 'abc:docs/design-system.md',
              origin: 'project',
              path: 'docs/design-system.md',
              name: 'design-system.md',
              size: 1200,
              author: 'Ada',
              changedAt: '2026-06-01T09:30:00.000Z',
              summary: 'Clarify navigation',
            },
          ],
        }
      }
      return { entries: [] }
    })
    Object.defineProperty(window, 'kernel', {
      configurable: true,
      value: {
        call,
        revealInFinder: vi.fn(),
        getPathForFile: vi.fn((file: File) => `/Users/test/incoming/${file.name}`),
      },
    })
    mounted = null
  })

  afterEach(() => {
    mounted?.app.unmount()
    mounted?.root.remove()
    mounted = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders a breadcrumb-backed file table with modified and created columns', async () => {
    mounted = mountFiles()
    await flushUi()

    expect(mounted.root.querySelector('[data-testid="files-browser-bar"]')).not.toBeNull()
    expect(loadSpy).toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith('fs.list', { path: '.', max_entries: 500, include_last_changed_by: true })
    expect(mounted.root.textContent).toContain('Modified')
    expect(mounted.root.textContent).toContain('Created')
    expect(mounted.root.textContent).toContain('Size')
    expect(mounted.root.textContent).toContain('README.md')
    expect(mounted.root.textContent).toContain('docs')
    expect(mounted.root.textContent).toContain('9 KB')
    expect(mounted.root.textContent).not.toContain('By')
    expect(mounted.root.querySelector('footer')).toBeNull()
    expect(mounted.root.querySelector('.tabler-icon-dots-vertical')).toBeNull()
  })

  it('shows breadcrumbs in the path bar for Browse and a mode label for other modes', async () => {
    mounted = mountFiles()
    await flushUi()

    const pathBar = () => mounted!.root.querySelector<HTMLElement>('[data-testid="files-path-bar"]')!
    expect(pathBar().textContent).toContain('workspace')

    const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
    docsRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(pathBar().textContent).toContain('docs')

    modeButton(mounted.root, 'Recent').click()
    await flushUi()
    expect(pathBar().textContent).toContain('Recent files')
    expect(pathBar().textContent).not.toContain('workspace')

    modeButton(mounted.root, 'Changed').click()
    await flushUi()
    expect(pathBar().textContent).toContain('Recently changed')

    modeButton(mounted.root, 'Browse').click()
    await type(mounted.root, 'design')
    expect(pathBar().textContent).toContain('Search results')
  })

  it('shows fetched Git changes with their authors and commit summaries', async () => {
    mounted = mountFiles()
    await flushUi()

    modeButton(mounted.root, 'Changed').click()
    await flushUi()

    expect(call).toHaveBeenCalledWith('awareness.recent', { limit: 240 })
    expect(mounted.root.textContent).toContain('Changed by')
    expect(mounted.root.textContent).toContain('Ada')
    expect(mounted.root.textContent).toContain('Clarify navigation')
  })

  it('navigates to an ancestor directory when its breadcrumb is clicked', async () => {
    mounted = mountFiles()
    await flushUi()

    const pathBar = () => mounted!.root.querySelector<HTMLElement>('[data-testid="files-path-bar"]')!
    const upButton = () => pathBar().querySelector<HTMLButtonElement>('[aria-label="Up one folder"]')!
    expect(upButton().disabled).toBe(true)

    const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
    docsRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(upButton().disabled).toBe(false)
    call.mockClear()

    const workspaceCrumb = Array.from(pathBar().querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'workspace')!
    workspaceCrumb.click()
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.list', { path: '.', max_entries: 500, include_last_changed_by: true })
    expect(pathBar().textContent).not.toContain('docs')
    expect(mounted.root.textContent).toContain('README.md')
    expect(upButton().disabled).toBe(true)
  })

  it('refreshes the current directory and workspace index when it becomes active again', async () => {
    const active = ref(false)
    mounted = mountReactiveFiles({ active })
    await flushUi()
    call.mockClear()

    active.value = true
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.list', { path: '.', max_entries: 500, include_last_changed_by: true })
    expect(refreshSpy).toHaveBeenCalledOnce()
  })

  it('refreshes when the active Files row is selected again', async () => {
    const refreshKey = ref(0)
    mounted = mountReactiveFiles({ refreshKey })
    await flushUi()
    call.mockClear()

    refreshKey.value += 1
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.list', { path: '.', max_entries: 500, include_last_changed_by: true })
    expect(refreshSpy).toHaveBeenCalledOnce()
  })

  it('expands folders on one click and navigates into them on double click', async () => {
    mounted = mountFiles()
    await flushUi()

    const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
    docsRow.click()
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.list', { path: 'docs', max_entries: 500, include_last_changed_by: true })
    expect(mounted.root.textContent).toContain('proposal.docx')
    expect(mounted.root.textContent).toContain('design-system.md')

    docsRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()

    expect(mounted.root.textContent).toContain('proposal.docx')
    expect(mounted.root.textContent).toContain('workspace')
  })

  it('marks the visible row for the active editor file', async () => {
    mounted = mountFiles({ activeFilePath: 'README.md' })
    await flushUi()

    const readme = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))
    expect(readme?.dataset.activeFile).toBe('true')
  })

  it('opens every file on one click and routes native formats to the OS app on double click', async () => {
    const onOpenFile = vi.fn()
    const onOpenFileNative = vi.fn()
    mounted = mountFiles({}, { onOpenFile, onOpenFileNative })
    await flushUi()
    await type(mounted.root, 'design')

    rowButtons(mounted.root)[0].click()
    await flushUi()
    expect(onOpenFile).toHaveBeenCalledWith('docs/design-system.md')

    onOpenFile.mockClear()
    await type(mounted.root, 'proposal')

    // Native formats still open something on single click (the file card in
    // Artifact via openFile); the OS app stays a deliberate double-click.
    const row = rowButtons(mounted.root)[0]
    expect(row.textContent).toContain('proposal.docx')
    row.click()
    await flushUi()
    expect(onOpenFile).toHaveBeenCalledWith('docs/proposal.docx')
    expect(onOpenFileNative).not.toHaveBeenCalled()

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(document.body.textContent).toContain('Open in Microsoft Word')

    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(onOpenFileNative).toHaveBeenCalledWith('docs/proposal.docx')
  })

  it('sorts columns when headers are clicked', async () => {
    mounted = mountFiles()
    await flushUi()

    const nameHeader = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Name'))!
    nameHeader.click()
    await flushUi()

    const names = rowButtons(mounted.root).map(row => row.textContent ?? '')
    expect(names[0]).toContain('docs')
    expect(names[1]).toContain('README.md')
  })

  it('keeps folders first when sorting browse rows by kind', async () => {
    call.mockImplementation(async (tool: string, params?: Record<string, unknown>) => {
      if (tool === 'fs.list' && params?.path === '.') {
        return {
          entries: [
            {
              path: 'archive.zip',
              name: 'archive.zip',
              type: 'file',
              size: 12000,
              modifiedAt: '2026-06-01T09:00:00.000Z',
              createdAt: '2026-06-01T09:00:00.000Z',
            },
            {
              path: 'docs',
              name: 'docs',
              type: 'directory',
              modifiedAt: '2026-06-01T08:00:00.000Z',
              createdAt: '2026-06-01T08:00:00.000Z',
            },
            {
              path: 'notes.md',
              name: 'notes.md',
              type: 'file',
              size: 2000,
              modifiedAt: '2026-06-01T07:00:00.000Z',
              createdAt: '2026-06-01T07:00:00.000Z',
            },
          ],
          truncated: false,
        }
      }
      if (tool === 'search.files') return { results: [] }
      return { entries: [] }
    })

    mounted = mountFiles()
    await flushUi()

    const kindHeader = Array.from(mounted.root.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Kind'))!
    kindHeader.click()
    await flushUi()

    let names = rowButtons(mounted.root).map(row => row.textContent ?? '')
    expect(names[0]).toContain('docs')
    expect(names[1]).toContain('archive.zip')

    kindHeader.click()
    await flushUi()

    names = rowButtons(mounted.root).map(row => row.textContent ?? '')
    expect(names[0]).toContain('docs')
    expect(names[1]).toContain('notes.md')
  })

  it('adds debounced file-content matches to search results', async () => {
    vi.useFakeTimers()
    mounted = mountFiles()
    await flushUi()
    await type(mounted.root, 'command palette')
    await waitForContentSearch()

    expect(call).toHaveBeenCalledWith('search.files', { query: 'command palette', max_results: 40 })
    expect(rowButtons(mounted.root)[0].textContent).toContain('App.vue')
    expect(mounted.root.textContent).toContain('src/renderer:42')
    expect(mounted.root.textContent).toContain('command palette')
  })

  it('ignores stale content-search responses after the query changes', async () => {
    vi.useFakeTimers()
    let resolveStale!: (value: { results: Array<{ path: string; line: number; snippet: string }> }) => void
    const staleResult = new Promise<{ results: Array<{ path: string; line: number; snippet: string }> }>((resolve) => {
      resolveStale = resolve
    })
    call.mockImplementation(async (tool: string, params?: Record<string, unknown>) => {
      if (tool === 'fs.list') return { entries: [], truncated: false }
      if (tool === 'search.files' && params?.query === 'stale query') return staleResult
      if (tool === 'search.files' && params?.query === 'live query') {
        return {
          results: [{
            path: 'docs/design-system.md',
            line: 12,
            snippet: 'The live query result should remain visible.',
          }],
        }
      }
      return { results: [] }
    })

    mounted = mountFiles()
    await flushUi()
    await type(mounted.root, 'stale query')
    await vi.advanceTimersByTimeAsync(220)
    await flushUi()

    await type(mounted.root, 'live query')
    await vi.advanceTimersByTimeAsync(220)
    await flushUi()

    expect(mounted.root.textContent).toContain('design-system.md')
    expect(mounted.root.textContent).toContain('docs:12')

    resolveStale({
      results: [{
        path: 'src/renderer/App.vue',
        line: 99,
        snippet: 'A stale query result arrived late.',
      }],
    })
    await flushUi()

    expect(mounted.root.textContent).toContain('design-system.md')
    expect(mounted.root.textContent).not.toContain('App.vue')
    expect(mounted.root.textContent).not.toContain('stale query result')
  })

  it('opens a custom context menu with file actions', async () => {
    mounted = mountFiles()
    await flushUi()

    const readmeRow = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))!
    readmeRow.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 24,
    }))
    await flushUi()

    expect(document.body.textContent).toContain('Open in Editor')
    expect(document.body.textContent).toContain('Reveal in Finder')
    expect(document.body.textContent).toContain('Copy path')
  })

  it('duplicates and trashes rows from the context menu', async () => {
    mounted = mountFiles()
    await flushUi()

    const readmeRow = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))!
    readmeRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
    await flushUi()
    modeButton(document.body, 'Duplicate').click()
    await flushUi()
    expect(call).toHaveBeenCalledWith('fs.copy', { path: 'README.md' })

    readmeRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
    await flushUi()
    modeButton(document.body, 'Delete').click()
    await flushUi()

    // Nothing moves before the confirmation dialog is answered.
    expect(call).not.toHaveBeenCalledWith('fs.trash', expect.anything())
    expect(document.body.textContent).toContain('Trash')
    modeButton(document.body, 'Delete file').click()
    await flushUi()
    expect(call).toHaveBeenCalledWith('fs.trash', { path: 'README.md' })
  })

  it('cancels delete from the confirmation dialog without touching the file', async () => {
    mounted = mountFiles()
    await flushUi()

    const readmeRow = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))!
    readmeRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
    await flushUi()
    modeButton(document.body, 'Delete').click()
    await flushUi()
    modeButton(document.body, 'Cancel').click()
    await flushUi()

    expect(call).not.toHaveBeenCalledWith('fs.trash', expect.anything())
    expect(document.body.textContent).not.toContain('moves to the Trash')
  })

  it('renames a row through the name dialog', async () => {
    mounted = mountFiles()
    await flushUi()

    const readmeRow = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))!
    readmeRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
    await flushUi()
    modeButton(document.body, 'Rename').click()
    await flushUi()

    const dialogInput = document.body.querySelector<HTMLInputElement>('input[placeholder="file-name.md"]')!
    expect(dialogInput.value).toBe('README.md')
    dialogInput.value = 'INTRO.md'
    dialogInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    dialogInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.rename', { old_path: 'README.md', new_path: 'INTRO.md' })
  })

  it('creates folders from the empty-area context menu', async () => {
    mounted = mountFiles()
    await flushUi()

    const container = mounted.root.querySelector<HTMLElement>('.overflow-y-auto')!
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
    await flushUi()
    expect(document.body.textContent).toContain('New file')
    modeButton(document.body, 'New folder').click()
    await flushUi()

    const dialogInput = document.body.querySelector<HTMLInputElement>('input[placeholder="folder-name"]')!
    dialogInput.value = 'assets'
    dialogInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    dialogInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.mkdir', { path: 'assets' })
  })

  it('creates and opens a new file from the context menu of a folder', async () => {
    const onOpenFile = vi.fn()
    mounted = mountFiles({}, { onOpenFile })
    await flushUi()

    const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
    docsRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
    await flushUi()
    modeButton(document.body, 'New file inside').click()
    await flushUi()

    const dialogInput = document.body.querySelector<HTMLInputElement>('input[placeholder="file-name.md"]')!
    dialogInput.value = 'notes.md'
    dialogInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    dialogInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.create', { path: 'docs/notes.md' })
    expect(onOpenFile).toHaveBeenCalledWith('docs/notes.md')
  })

  it('imports OS-dragged files into the current folder with a drop overlay', async () => {
    mounted = mountFiles()
    await flushUi()

    const container = mounted.root.querySelector<HTMLElement>('[data-testid="files-drop-zone"]')!
    const file = new File(['x'], 'photo.png')
    const dataTransfer = { files: [file], types: ['Files'] }

    const enter = new Event('dragenter', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(enter, 'dataTransfer', { value: dataTransfer })
    container.dispatchEvent(enter)
    await flushUi()
    expect(mounted.root.textContent).toContain('Drop to import')

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    container.dispatchEvent(drop)
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.import', {
      source_path: '/Users/test/incoming/photo.png',
      dest_dir: '.',
    })
    expect(mounted.root.textContent).not.toContain('Drop to import')
  })

  it('imports OS-dragged files into the hovered folder row', async () => {
    mounted = mountFiles()
    await flushUi()

    const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
    const file = new File(['x'], 'report.docx')
    const dataTransfer = { files: [file], types: ['Files'] }

    const over = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(over, 'dataTransfer', { value: dataTransfer })
    docsRow.dispatchEvent(over)
    await flushUi()

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    docsRow.dispatchEvent(drop)
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.import', {
      source_path: '/Users/test/incoming/report.docx',
      dest_dir: 'docs',
    })
  })

  it('moves workspace-dragged files into the hovered folder row', async () => {
    const onPathMoved = vi.fn()
    mounted = mountFiles({}, { onPathMoved })
    await flushUi()

    const readmeRow = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))!
    const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
    const transfer = dataTransfer()

    const start = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(start, 'dataTransfer', { value: transfer })
    readmeRow.dispatchEvent(start)

    const over = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(over, 'dataTransfer', { value: transfer })
    docsRow.dispatchEvent(over)

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    docsRow.dispatchEvent(drop)
    await flushUi()

    expect(call).toHaveBeenCalledWith('fs.rename', {
      old_path: 'README.md',
      new_path: 'docs/README.md',
    })
    expect(onPathMoved).toHaveBeenCalledWith({
      oldPath: 'README.md',
      newPath: 'docs/README.md',
      type: 'file',
    })
  })

  it('ignores workspace-dragged no-op moves before calling fs.rename', async () => {
    mounted = mountFiles()
    await flushUi()

    const readmeRow = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))!
    const container = mounted.root.querySelector<HTMLElement>('[data-testid="files-drop-zone"]')!
    const transfer = dataTransfer()

    const start = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(start, 'dataTransfer', { value: transfer })
    readmeRow.dispatchEvent(start)

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    container.dispatchEvent(drop)
    await flushUi()

    expect(call).not.toHaveBeenCalledWith('fs.rename', expect.anything())
  })

  it('ignores drags that carry no OS files', async () => {
    mounted = mountFiles()
    await flushUi()

    const container = mounted.root.querySelector<HTMLElement>('[data-testid="files-drop-zone"]')!
    const dataTransfer = { files: [], types: ['text/plain'] }

    const enter = new Event('dragenter', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(enter, 'dataTransfer', { value: dataTransfer })
    container.dispatchEvent(enter)
    await flushUi()
    expect(mounted.root.textContent).not.toContain('Drop to import')

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    container.dispatchEvent(drop)
    await flushUi()
    expect(call).not.toHaveBeenCalledWith('fs.import', expect.anything())
  })

  it('hides the drop overlay when the drag leaves without dropping', async () => {
    mounted = mountFiles()
    await flushUi()

    const container = mounted.root.querySelector<HTMLElement>('[data-testid="files-drop-zone"]')!
    const dataTransfer = { files: [new File(['x'], 'photo.png')], types: ['Files'] }

    const enter = new Event('dragenter', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(enter, 'dataTransfer', { value: dataTransfer })
    container.dispatchEvent(enter)
    await flushUi()
    expect(mounted.root.textContent).toContain('Drop to import')

    const leave = new Event('dragleave', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(leave, 'dataTransfer', { value: dataTransfer })
    container.dispatchEvent(leave)
    await flushUi()

    expect(mounted.root.textContent).not.toContain('Drop to import')
    expect(call).not.toHaveBeenCalledWith('fs.import', expect.anything())
  })

  it('shows Changed as a workspace-wide fetched-change table', async () => {
    mounted = mountFiles()
    await flushUi()

    modeButton(mounted.root, 'Changed').click()
    await flushUi()

    const names = rowButtons(mounted.root).map(row => row.textContent ?? '')
    expect(names[0]).toContain('design-system.md')
    expect(names[0]).toContain('Ada')
    expect(names[0]).toContain('Clarify navigation')
    expect(mounted.root.textContent).toContain('Changed by')
  })

  it('shows recent files with metadata from the workspace index', async () => {
    mounted = mountFiles({
      recentFiles: [{ path: 'docs/proposal.docx', name: 'proposal.docx' }],
    })
    await flushUi()

    modeButton(mounted.root, 'Recent').click()
    await flushUi()

    expect(rowButtons(mounted.root)).toHaveLength(1)
    expect(mounted.root.textContent).toContain('proposal.docx')
    expect(mounted.root.textContent).toContain('docs')
    expect(mounted.root.textContent).toContain('47 KB')
  })

  it('shows one writable Files root under the actual Team name', async () => {
    call.mockImplementation(async (tool: string, params?: Record<string, unknown>) => {
      if (tool === 'fs.list' && params?.path === '.') {
        return { entries: [{ path: 'README.md', name: 'README.md', type: 'file' }], truncated: false }
      }
      if (tool === 'fs.list' && params?.path === '.mim/team/files') {
        return {
          entries: [{ path: '.mim/team/files/logo.svg', name: 'logo.svg', type: 'file', size: 800 }],
          truncated: false,
        }
      }
      if (tool === 'fs.list') return { entries: [], truncated: false }
      if (tool === 'team.status') {
        return { state: 'synced', team: { name: 'Acme Research' } }
      }
      if (tool === 'search.files') return { results: [] }
      return { entries: [] }
    })

    mounted = mountFiles()
    await flushUi()

    const header = mounted.root.querySelector<HTMLElement>('[data-testid="files-team-header"]')
    expect(header?.textContent).toContain('Acme Research')
    expect(header?.textContent).not.toMatch(/\b1\b/)

    expect(header?.className).toContain('sticky')
    const scrollSpy = vi.fn()
    header!.scrollIntoView = scrollSpy
    header!.click()
    await flushUi()
    expect(scrollSpy).toHaveBeenCalled()

    const rows = rowButtons(mounted.root)
    const files = rows.find(row => row.textContent?.includes('Files'))!
    expect(files).toBeDefined()
    expect(files.disabled).toBe(false)
    expect(mounted.root.querySelector('.tabler-icon-lock')).toBeNull()
    expect(mounted.root.textContent).not.toContain('not-synced')
    expect(mounted.root.textContent).not.toContain('.mim/team')

    files.click()
    await flushUi()
    expect(call).toHaveBeenCalledWith('fs.list', expect.objectContaining({ path: '.mim/team/files' }))
    expect(mounted.root.textContent).toContain('logo.svg')

    files.click()
    await flushUi()
    expect(mounted.root.textContent).not.toContain('logo.svg')
  })

  it('preserves expanded folders after deleting a child item', async () => {
    call.mockImplementation(async (tool: string, params?: Record<string, unknown>) => {
      if (tool === 'fs.list' && params?.path === '.') {
        return {
          entries: [
            { path: 'docs', name: 'docs', type: 'directory', modifiedAt: '2026-06-01T08:00:00.000Z', createdAt: '2026-01-18T09:00:00.000Z' },
          ],
          truncated: false,
        }
      }
      if (tool === 'fs.list' && params?.path === 'docs') {
        return {
          entries: [
            { path: 'docs/alpha.md', name: 'alpha.md', type: 'file', size: 100, modifiedAt: '2026-06-01T09:00:00.000Z', createdAt: '2026-06-01T09:00:00.000Z' },
            { path: 'docs/beta.md', name: 'beta.md', type: 'file', size: 200, modifiedAt: '2026-06-01T09:00:00.000Z', createdAt: '2026-06-01T09:00:00.000Z' },
          ],
          truncated: false,
        }
      }
      if (tool === 'fs.trash') return {}
      if (tool === 'search.files') return { results: [] }
      return { entries: [] }
    })

    mounted = mountFiles()
    await flushUi()

    // Expand docs folder
    const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
    docsRow.click()
    await flushUi()
    expect(mounted.root.textContent).toContain('alpha.md')
    expect(mounted.root.textContent).toContain('beta.md')

    // Delete alpha.md via context menu
    const alphaRow = rowButtons(mounted.root).find(row => row.textContent?.includes('alpha.md'))!
    alphaRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
    await flushUi()
    modeButton(document.body, 'Delete').click()
    await flushUi()

    // After delete, update mock to no longer return alpha.md
    call.mockImplementation(async (tool: string, params?: Record<string, unknown>) => {
      if (tool === 'fs.list' && params?.path === '.') {
        return {
          entries: [
            { path: 'docs', name: 'docs', type: 'directory', modifiedAt: '2026-06-01T08:00:00.000Z', createdAt: '2026-01-18T09:00:00.000Z' },
          ],
          truncated: false,
        }
      }
      if (tool === 'fs.list' && params?.path === 'docs') {
        return {
          entries: [
            { path: 'docs/beta.md', name: 'beta.md', type: 'file', size: 200, modifiedAt: '2026-06-01T09:00:00.000Z', createdAt: '2026-06-01T09:00:00.000Z' },
          ],
          truncated: false,
        }
      }
      if (tool === 'search.files') return { results: [] }
      return { entries: [] }
    })

    modeButton(document.body, 'Delete file').click()
    await flushUi()

    // The docs folder should still be expanded with beta.md visible
    expect(mounted.root.textContent).toContain('beta.md')
    expect(mounted.root.textContent).not.toContain('alpha.md')
  })

  describe('multi-select', () => {
    function fourFileMock() {
      call.mockImplementation(async (tool: string, params?: Record<string, unknown>) => {
        if (tool === 'fs.list' && params?.path === '.') {
          return {
            entries: ['a.md', 'b.md', 'c.md', 'd.md'].map((name, i) => ({
              path: name,
              name,
              type: 'file',
              size: 100,
              modifiedAt: `2026-06-0${4 - i}T09:00:00.000Z`,
              createdAt: '2026-01-01T09:00:00.000Z',
            })),
            truncated: false,
          }
        }
        if (tool === 'search.files') return { results: [] }
        return { entries: [] }
      })
    }

    function clickRow(root: HTMLElement, name: string, init: MouseEventInit = {}) {
      const row = rowButtons(root).find(item => item.textContent?.includes(name))!
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
    }

    function selectedNames(root: HTMLElement) {
      return rowButtons(root)
        .filter(row => row.dataset.selected === 'true')
        .map(row => row.querySelector('[data-testid="files-row-name"]')?.textContent ?? '')
    }

    it('toggles rows with cmd/ctrl+click without opening them', async () => {
      const onOpenFile = vi.fn()
      fourFileMock()
      mounted = mountFiles({}, { onOpenFile })
      await flushUi()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      await flushUi()
      clickRow(mounted.root, 'c.md', { ctrlKey: true })
      await flushUi()

      expect(selectedNames(mounted.root)).toEqual(['a.md', 'c.md'])
      expect(onOpenFile).not.toHaveBeenCalled()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      await flushUi()
      expect(selectedNames(mounted.root)).toEqual(['c.md'])
    })

    it('selects everything in between on cmd/ctrl+shift+click', async () => {
      const onOpenFile = vi.fn()
      fourFileMock()
      mounted = mountFiles({}, { onOpenFile })
      await flushUi()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      await flushUi()
      clickRow(mounted.root, 'c.md', { metaKey: true, shiftKey: true })
      await flushUi()

      expect(selectedNames(mounted.root)).toEqual(['a.md', 'b.md', 'c.md'])
      expect(onOpenFile).not.toHaveBeenCalled()
    })

    it('replaces the selection with the range on plain shift+click', async () => {
      fourFileMock()
      mounted = mountFiles({}, { onOpenFile: vi.fn() })
      await flushUi()

      clickRow(mounted.root, 'd.md', { metaKey: true })
      await flushUi()
      clickRow(mounted.root, 'a.md', { metaKey: true })
      await flushUi()
      clickRow(mounted.root, 'b.md', { shiftKey: true })
      await flushUi()

      expect(selectedNames(mounted.root)).toEqual(['a.md', 'b.md'])
    })

    it('collapses the selection on plain click and opens as usual', async () => {
      const onOpenFile = vi.fn()
      fourFileMock()
      mounted = mountFiles({}, { onOpenFile })
      await flushUi()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      clickRow(mounted.root, 'c.md', { metaKey: true })
      await flushUi()
      clickRow(mounted.root, 'b.md')
      await flushUi()

      expect(onOpenFile).toHaveBeenCalledWith('b.md')
      expect(selectedNames(mounted.root)).toEqual(['b.md'])
    })

    it('clears the selection with Escape', async () => {
      fourFileMock()
      mounted = mountFiles()
      await flushUi()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      clickRow(mounted.root, 'b.md', { metaKey: true })
      await flushUi()
      expect(selectedNames(mounted.root)).toHaveLength(2)

      input(mounted.root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(selectedNames(mounted.root)).toHaveLength(0)
    })

    it('offers bulk delete from the context menu of a selected row', async () => {
      fourFileMock()
      mounted = mountFiles()
      await flushUi()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      clickRow(mounted.root, 'c.md', { metaKey: true })
      await flushUi()

      const row = rowButtons(mounted.root).find(item => item.textContent?.includes('a.md'))!
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
      await flushUi()

      expect(document.body.textContent).toContain('Delete 2 items')
      expect(document.body.textContent).toContain('Copy 2 paths')
      expect(document.body.textContent).not.toContain('Rename')

      modeButton(document.body, 'Delete 2 items').click()
      await flushUi()
      expect(call).not.toHaveBeenCalledWith('fs.trash', expect.anything())
      expect(document.body.textContent).toContain('Delete 2 items?')

      modeButton(document.body, 'Delete 2 items').click()
      await flushUi()
      expect(call).toHaveBeenCalledWith('fs.trash', { path: 'a.md' })
      expect(call).toHaveBeenCalledWith('fs.trash', { path: 'c.md' })
    })

    it('copies all selected paths from the bulk menu', async () => {
      const writeText = vi.fn()
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      fourFileMock()
      mounted = mountFiles()
      await flushUi()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      clickRow(mounted.root, 'c.md', { metaKey: true })
      await flushUi()

      const row = rowButtons(mounted.root).find(item => item.textContent?.includes('c.md'))!
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
      await flushUi()
      modeButton(document.body, 'Copy 2 paths').click()
      await flushUi()

      expect(writeText).toHaveBeenCalledWith('a.md\nc.md')
    })

    it('shows the single-row menu when right-clicking outside the selection', async () => {
      fourFileMock()
      mounted = mountFiles()
      await flushUi()

      clickRow(mounted.root, 'a.md', { metaKey: true })
      clickRow(mounted.root, 'b.md', { metaKey: true })
      await flushUi()

      const row = rowButtons(mounted.root).find(item => item.textContent?.includes('d.md'))!
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 }))
      await flushUi()

      expect(document.body.textContent).toContain('Rename')
      expect(document.body.textContent).not.toContain('Delete 2 items')
      expect(selectedNames(mounted.root)).toEqual(['d.md'])
    })

    it('moves the whole selection when a selected row is dragged onto a folder', async () => {
      const onPathMoved = vi.fn()
      mounted = mountFiles({}, { onPathMoved })
      await flushUi()

      clickRow(mounted.root, 'README.md', { metaKey: true })
      clickRow(mounted.root, 'docs', { metaKey: true })
      await flushUi()
      expect(call).not.toHaveBeenCalledWith('fs.list', expect.objectContaining({ path: 'docs' }))

      const readmeRow = rowButtons(mounted.root).find(row => row.textContent?.includes('README.md'))!
      const docsRow = rowButtons(mounted.root).find(row => row.textContent?.includes('docs'))!
      const transfer = dataTransfer()

      const start = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperty(start, 'dataTransfer', { value: transfer })
      readmeRow.dispatchEvent(start)

      const over = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperty(over, 'dataTransfer', { value: transfer })
      docsRow.dispatchEvent(over)

      const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperty(drop, 'dataTransfer', { value: transfer })
      docsRow.dispatchEvent(drop)
      await flushUi()

      // docs cannot move into itself; README.md still moves.
      expect(call).toHaveBeenCalledWith('fs.rename', {
        old_path: 'README.md',
        new_path: 'docs/README.md',
      })
      expect(call).not.toHaveBeenCalledWith('fs.rename', expect.objectContaining({ old_path: 'docs' }))
      expect(onPathMoved).toHaveBeenCalledTimes(1)
    })

    it('selects every selectable row with cmd/ctrl+A while the search box is empty', async () => {
      fourFileMock()
      mounted = mountFiles()
      await flushUi()

      input(mounted.root).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }),
      )
      await flushUi()

      expect(selectedNames(mounted.root)).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
    })

    it('leaves cmd/ctrl+A to the browser default while the search box has text', async () => {
      fourFileMock()
      mounted = mountFiles()
      await flushUi()
      await type(mounted.root, 'a')

      input(mounted.root).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }),
      )
      await flushUi()

      expect(selectedNames(mounted.root)).toEqual([])
    })

  })

  it('keeps secondary file commands in the More menu', async () => {
    const onNewFile = vi.fn()
    const onOpenFileDialog = vi.fn()
    mounted = mountFiles({}, { onNewFile, onOpenFileDialog })
    await flushUi()

    modeButton(mounted.root, 'More file actions').click()
    await flushUi()

    expect(document.body.textContent).toContain('New draft')
    expect(document.body.textContent).toContain('Open file...')

    modeButton(document.body, 'New draft').click()
    await flushUi()
    expect(onNewFile).toHaveBeenCalledOnce()

    modeButton(mounted.root, 'More file actions').click()
    await flushUi()
    modeButton(document.body, 'Open file...').click()
    await flushUi()
    expect(onOpenFileDialog).toHaveBeenCalledOnce()
  })
})
