import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { createTraceLog, type TraceEvent } from '@main/trace/trace.js'
import { createPackageEnablementStore } from '@main/packages/packageEnablement.js'
import { createPackageJobRunner } from '@main/packages/packageJobs.js'
import { createPackageRuntime } from '@main/packages/packageRuntime.js'
import { createPackageLoader } from '@main/packages/packages.js'
import { createToolRegistry } from '@main/tools/registry.js'
import { atomicWriteJson } from '@main/atomicJson.js'

describe('app job runner', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mim-jobs-test-'))
    mkdirSync(join(dir, 'packages'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writePackage(backend: string): void {
    const pkgDir = join(dir, 'packages', 'worker')
    mkdirSync(join(pkgDir, 'backend'), { recursive: true })
    mkdirSync(join(pkgDir, 'ui'), { recursive: true })
    writeFileSync(join(pkgDir, 'ui', 'index.html'), '<h1>Worker</h1>')
    writeFileSync(join(pkgDir, 'backend', 'index.mjs'), backend)
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@mim/worker',
      version: '0.1.0',
      type: 'module',
      mim: {
        manifestVersion: 1,
        id: 'worker',
        name: 'Worker',
        views: [],
        backend: './backend/index.mjs',
        permissions: {},
      },
    }))
  }

  async function makeRunner(events: unknown[] = [], traceEvents: TraceEvent[] = []) {
    const trace = createTraceLog({ devConsole: false, sinks: [{ write: (e) => traceEvents.push(e) }] })
    const tools = createToolRegistry(trace)
    tools.setWorkspacePath(dir)
    const packages = await createPackageLoader(tools)
    const enablement = createPackageEnablementStore({ getWorkspacePath: () => dir })
    enablement.setEnabled('worker', true)
    const workerPkg = packages.get('worker')
    if (workerPkg) enablement.ackTrust(workerPkg)
    const runtime = createPackageRuntime({ packages, enablement, tools, trace })
    const runner = createPackageJobRunner({
      runtime,
      trace,
      getWorkspacePath: () => dir,
      emit: (_event, data) => events.push(data),
    })
    return runner
  }

  it('runs a job, emits progress, and persists the summary', async () => {
    writePackage(`
      export const jobs = {
        count: {
          label: 'Count',
          async run(ctx, input) {
            await ctx.progress.step('Counting')
            return { count: input.value }
          }
        }
      }
    `)
    const events: unknown[] = []
    const runner = await makeRunner(events)

    const started = await runner.start('worker', 'count', { value: 3 })
    const completed = await runner.waitForRun(started.runId)

    expect(completed.status).toBe('completed')
    expect(completed.result).toEqual({ count: 3 })
    expect(completed.events.map(event => event.type)).toContain('job.step')
    expect(runner.get(started.runId)?.status).toBe('completed')
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect((event as { ephemeral?: boolean }).ephemeral).toBeUndefined()
    }
  })

  it('traces the run as a span tree rooted at the run id', async () => {
    writePackage(`
      export const jobs = {
        count: {
          label: 'Count',
          async run(ctx, input) {
            await ctx.progress.step('Counting')
            return { count: input.value }
          }
        }
      }
    `)
    const traceEvents: TraceEvent[] = []
    const runner = await makeRunner([], traceEvents)

    const started = await runner.start('worker', 'count', { value: 3 })
    await runner.waitForRun(started.runId)

    const runEvents = traceEvents.filter(e => e.runId === started.runId)
    const startedEvent = runEvents.find(e => e.kind === 'job.started')!
    expect(startedEvent.traceId).toBe(started.runId)
    expect(startedEvent.spanId).toBe(started.runId)
    expect(startedEvent.actor).toBe('package')
    expect(startedEvent.packageId).toBe('worker')

    const step = runEvents.find(e => e.kind === 'job.step')!
    expect(step.parentSpanId).toBe(started.runId)

    const done = runEvents.find(e => e.kind === 'job.done')!
    expect(done.status).toBe('ok')
    expect(done.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records failed jobs without throwing away the run timeline', async () => {
    writePackage(`
      export const jobs = {
        fail: {
          async run(ctx) {
            await ctx.progress.step('About to fail')
            throw new Error('boom')
          }
        }
      }
    `)
    const runner = await makeRunner()

    const started = await runner.start('worker', 'fail')
    const failed = await runner.waitForRun(started.runId)

    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('boom')
    expect(failed.events.map(event => event.type)).toContain('job.failed')
  })

  it('cancels in-flight jobs through the abort signal', async () => {
    writePackage(`
      export const jobs = {
        wait: {
          async run(ctx) {
            await new Promise(resolve => ctx.abort.signal.addEventListener('abort', resolve, { once: true }))
            ctx.abort.throwIfAborted()
            return { ok: true }
          }
        }
      }
    `)
    const runner = await makeRunner()

    const started = await runner.start('worker', 'wait')
    const cancelled = await runner.cancel(started.runId)
    const final = await runner.waitForRun(started.runId)

    expect(cancelled.status).toBe('cancelled')
    expect(final.status).toBe('cancelled')
    expect(final.events.map(event => event.type)).toContain('job.cancelled')
  })

  it('cancels every in-flight job during app shutdown', async () => {
    writePackage(`
      export const jobs = {
        wait: {
          concurrency: 'parallel',
          async run(ctx) {
            await new Promise(resolve => ctx.abort.signal.addEventListener('abort', resolve, { once: true }))
            ctx.abort.throwIfAborted()
          }
        }
      }
    `)
    const runner = await makeRunner()
    const first = await runner.start('worker', 'wait')
    const second = await runner.start('worker', 'wait')

    runner.cancelAll()

    await expect(runner.waitForRun(first.runId)).resolves.toMatchObject({ status: 'cancelled' })
    await expect(runner.waitForRun(second.runId)).resolves.toMatchObject({ status: 'cancelled' })
    expect(runner.activeRunCount()).toBe(0)
  })

  it('rejects a second active run for single-concurrency jobs', async () => {
    writePackage(`
      let releaseRun
      const gate = new Promise(resolve => { releaseRun = resolve })
      globalThis.__mim_release_slow_job__ = () => releaseRun?.()
      export const jobs = {
        slow: {
          async run() { await gate; return true }
        }
      }
    `)
    const runner = await makeRunner()

    const started = await runner.start('worker', 'slow')

    await expect(runner.start('worker', 'slow')).rejects.toThrow('Job already running')
    ;(globalThis as Record<string, () => void>).__mim_release_slow_job__?.()
    await runner.waitForRun(started.runId)
    delete (globalThis as Record<string, unknown>).__mim_release_slow_job__
  })

  it('archives, restores, and deletes persisted app runs', async () => {
    writePackage(`
      export const jobs = {
        count: {
          async run() { return { ok: true } }
        }
      }
    `)
    const runner = await makeRunner()

    const started = await runner.start('worker', 'count')
    const completed = await runner.waitForRun(started.runId)

    expect(completed.archived).not.toBe(true)
    expect(runner.list().map(run => run.runId)).toContain(started.runId)

    const archived = runner.archive(started.runId)
    expect(archived.archived).toBe(true)
    expect(runner.get(started.runId)?.archived).toBe(true)
    expect(runner.list().map(run => run.runId)).not.toContain(started.runId)
    expect(runner.list(undefined, { archived: true }).map(run => run.runId)).toEqual([started.runId])

    const restored = runner.archive(started.runId, false)
    expect(restored.archived).toBe(false)
    expect(runner.list().map(run => run.runId)).toContain(started.runId)

    expect(runner.delete(started.runId)).toEqual({ deleted: started.runId })
    expect(runner.get(started.runId)).toBe(null)
  })

  it('runs ephemeral jobs without leaving a persisted run record', async () => {
    writePackage(`
      let releaseRun
      const gate = new Promise(resolve => { releaseRun = resolve })
      globalThis.__mim_release_ephemeral_job__ = () => releaseRun?.()
      export const jobs = {
        sync: {
          label: 'Sync',
          ephemeral: true,
          async run(ctx) {
            await ctx.progress.step('Syncing')
            await gate
            return { synced: 2 }
          }
        }
      }
    `)
    const events: unknown[] = []
    const runner = await makeRunner(events)

    const started = await runner.start('worker', 'sync')

    expect(runner.get(started.runId)?.status).toBe('running')

    ;(globalThis as Record<string, unknown> & { __mim_release_ephemeral_job__?: () => void }).__mim_release_ephemeral_job__?.()
    const completed = await runner.waitForRun(started.runId)
    delete (globalThis as Record<string, unknown>).__mim_release_ephemeral_job__

    expect(completed.status).toBe('completed')
    expect(completed.result).toEqual({ synced: 2 })
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect((event as { ephemeral?: boolean }).ephemeral).toBe(true)
    }
    expect(runner.list(undefined, { includeArchived: true })).toEqual([])
    expect(runner.get(started.runId)).toBe(null)
    expect(existsSync(join(dir, '.mim', 'packages', 'worker', 'runs'))).toBe(false)
  })

  it('keeps cancelled ephemeral runs off disk and tags their events', async () => {
    writePackage(`
      export const jobs = {
        sync: {
          ephemeral: true,
          async run(ctx) {
            await new Promise(resolve => ctx.abort.signal.addEventListener('abort', resolve, { once: true }))
            ctx.abort.throwIfAborted()
            return { ok: true }
          }
        }
      }
    `)
    const events: unknown[] = []
    const runner = await makeRunner(events)

    const started = await runner.start('worker', 'sync')
    await runner.cancel(started.runId)
    const final = await runner.waitForRun(started.runId)

    expect(final.status).toBe('cancelled')
    for (const event of events) {
      expect((event as { ephemeral?: boolean }).ephemeral).toBe(true)
    }
    expect(existsSync(join(dir, '.mim', 'packages', 'worker', 'runs'))).toBe(false)
  })

  it('renames persisted package runs without rewriting the original job event', async () => {
    writePackage(`
      export const jobs = {
        count: {
          label: 'Count',
          async run() { return { ok: true } }
        }
      }
    `)
    const runner = await makeRunner()

    const started = await runner.start('worker', 'count')
    await runner.waitForRun(started.runId)

    const renamed = runner.rename(started.runId, 'Quarterly count')

    expect(renamed.label).toBe('Quarterly count')
    expect(runner.get(started.runId)?.label).toBe('Quarterly count')
    expect(renamed.events.find(event => event.type === 'job.started')?.data?.label).toBe('Count')
    expect(() => runner.rename(started.runId, '   ')).toThrow('Package run label cannot be empty')
  })

  it('marks stale running records as failed on reconcile', async () => {
    writePackage(`
      export const jobs = {
        count: { async run() { return { ok: true } } }
      }
    `)
    // Simulate a persisted "running" record left by a crashed previous session
    const staleRunId = randomUUID()
    const runsDir = join(dir, '.mim', 'packages', 'worker', 'runs')
    mkdirSync(runsDir, { recursive: true })
    atomicWriteJson(join(runsDir, `${staleRunId}.json`), {
      runId: staleRunId,
      packageId: 'worker',
      jobId: 'count',
      status: 'running',
      inputs: {},
      startedAt: '2026-06-01T00:00:00.000Z',
      events: [{ type: 'job.started', packageId: 'worker', jobId: 'count', runId: staleRunId, ts: '2026-06-01T00:00:00.000Z', sequence: 1 }],
    })

    const runner = await makeRunner()
    runner.reconcileStaleRuns()

    const record = runner.get(staleRunId)
    expect(record).not.toBeNull()
    expect(record!.status).toBe('failed')
    expect(record!.error).toBe('Interrupted by app restart')
    expect(record!.completedAt).toBeTruthy()
  })

  it('cancel on a stale record transitions it to failed', async () => {
    writePackage(`
      export const jobs = {
        count: { async run() { return { ok: true } } }
      }
    `)
    const staleRunId = randomUUID()
    const runsDir = join(dir, '.mim', 'packages', 'worker', 'runs')
    mkdirSync(runsDir, { recursive: true })
    atomicWriteJson(join(runsDir, `${staleRunId}.json`), {
      runId: staleRunId,
      packageId: 'worker',
      jobId: 'count',
      status: 'running',
      inputs: {},
      startedAt: '2026-06-01T00:00:00.000Z',
      events: [],
    })

    const runner = await makeRunner()
    const result = await runner.cancel(staleRunId)

    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('Cancelled after app restart')
    expect(result.completedAt).toBeTruthy()
    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(join(runsDir, `${staleRunId}.json`), 'utf-8'))
    expect(onDisk.status).toBe('cancelled')
  })

  it('reports whether any runs are active', async () => {
    writePackage(`
      let releaseRun
      const gate = new Promise(resolve => { releaseRun = resolve })
      globalThis.__mim_release_active_check__ = () => releaseRun?.()
      export const jobs = {
        slow: {
          async run() { await gate; return true }
        }
      }
    `)
    const runner = await makeRunner()

    expect(runner.hasActiveRuns()).toBe(false)

    const started = await runner.start('worker', 'slow')
    expect(runner.hasActiveRuns()).toBe(true)

    ;(globalThis as Record<string, () => void>).__mim_release_active_check__?.()
    await runner.waitForRun(started.runId)
    delete (globalThis as Record<string, unknown>).__mim_release_active_check__

    expect(runner.hasActiveRuns()).toBe(false)
  })
})
