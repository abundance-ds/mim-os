import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { packageRunsDir } from '@main/packages/packageData.js'
import type { PackageRuntime } from '@main/packages/packageRuntime.js'
import { atomicWriteJson } from '@main/atomicJson.js'
import type { TraceLog } from '@main/trace/trace.js'

export type PackageRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface PackageRunEvent {
  type: string
  packageId: string
  jobId: string
  runId: string
  ts: string
  sequence: number
  ephemeral?: true
  data?: Record<string, unknown>
}

export interface PackageRunRecord {
  runId: string
  packageId: string
  jobId: string
  label?: string
  status: PackageRunStatus
  inputs: Record<string, unknown>
  startedAt: string
  completedAt?: string
  result?: unknown
  error?: string
  archived?: boolean
  ephemeral?: true
  events: PackageRunEvent[]
}

export interface PackageJobRunner {
  start(packageId: string, jobId: string, inputs?: Record<string, unknown>): Promise<{ runId: string; status: PackageRunStatus; ephemeral?: true }>
  cancel(runId: string): Promise<PackageRunRecord>
  cancelAll(): void
  get(runId: string): PackageRunRecord | null
  list(packageId?: string, options?: { includeArchived?: boolean; archived?: boolean }): PackageRunRecord[]
  rename(runId: string, label: string): PackageRunRecord
  archive(runId: string, archived?: boolean): PackageRunRecord
  delete(runId: string): { deleted: string }
  waitForRun(runId: string): Promise<PackageRunRecord>
  reconcileStaleRuns(): void
  hasActiveRuns(): boolean
  activeRunCount(): number
}

interface PackageJobRunnerOptions {
  runtime: PackageRuntime
  getWorkspacePath: () => string | null
  emit?: (event: string, data: unknown) => void
  trace?: TraceLog
}

interface ActiveRun {
  record: PackageRunRecord
  controller: AbortController
  promise: Promise<PackageRunRecord>
}

export function createPackageJobRunner(options: PackageJobRunnerOptions): PackageJobRunner {
  const active = new Map<string, ActiveRun>()
  const activeByPackageJob = new Map<string, string>()

  async function start(packageId: string, jobId: string, inputs: Record<string, unknown> = {}) {
    const { pkg, job } = await options.runtime.getJob(packageId, jobId)
    const concurrencyKey = `${packageId}:${jobId}`
    if (job.concurrency !== 'parallel' && activeByPackageJob.has(concurrencyKey)) {
      throw new Error(`Job already running: ${packageId}.${jobId}`)
    }

    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    const record: PackageRunRecord = {
      runId,
      packageId,
      jobId,
      label: job.label,
      status: 'running',
      inputs,
      startedAt,
      ...(job.ephemeral ? { ephemeral: true as const } : {}),
      events: [],
    }
    const controller = new AbortController()
    emit(record, 'job.started', { label: job.label })
    persist(record)

    const promise = (async () => {
      try {
        const ctx = options.runtime.createContext({
          pkg,
          job: { id: jobId, runId, startedAt },
          inputs,
          signal: controller.signal,
          progress: {
            step: (name) => emit(record, 'job.step', { name }),
            log: (message) => emit(record, 'job.log', { message }),
            progress: (value, label) => emit(record, 'job.progress', { value, label }),
            done: (summary) => emit(record, 'job.done', { summary }),
          },
        })
        ctx.abort.throwIfAborted()
        const result = await job.run(ctx, inputs)
        if (record.status === 'cancelled') return record
        record.status = 'completed'
        record.result = result
        record.completedAt = new Date().toISOString()
        emit(record, 'job.done', { result: summarize(result) })
        persist(record)
        return record
      } catch (err) {
        if (record.status === 'cancelled' || controller.signal.aborted) {
          record.status = 'cancelled'
          record.error = 'Package job cancelled'
          record.completedAt = record.completedAt ?? new Date().toISOString()
          persist(record)
          return record
        }
        record.status = 'failed'
        record.error = (err as Error).message
        record.completedAt = new Date().toISOString()
        emit(record, 'job.failed', { error: record.error })
        persist(record)
        return record
      } finally {
        active.delete(runId)
        if (activeByPackageJob.get(concurrencyKey) === runId) activeByPackageJob.delete(concurrencyKey)
      }
    })()

    active.set(runId, { record, controller, promise })
    activeByPackageJob.set(concurrencyKey, runId)
    return { runId, status: record.status, ...(record.ephemeral ? { ephemeral: true as const } : {}) }
  }

  async function cancel(runId: string): Promise<PackageRunRecord> {
    const current = active.get(runId)
    if (!current) {
      const record = get(runId)
      if (!record) throw new Error(`Package run not found: ${runId}`)
      // Stale record with no live process: transition to a terminal state
      if (record.status === 'running') {
        record.status = 'cancelled'
        record.error = 'Cancelled after app restart'
        record.completedAt = new Date().toISOString()
        persist(record)
      }
      return record
    }
    current.controller.abort()
    current.record.status = 'cancelled'
    current.record.error = 'Package job cancelled'
    current.record.completedAt = new Date().toISOString()
    emit(current.record, 'job.cancelled', {})
    persist(current.record)
    return current.record
  }

  function cancelAll(): void {
    for (const runId of [...active.keys()]) void cancel(runId)
  }

  function get(runId: string): PackageRunRecord | null {
    const current = active.get(runId)
    if (current) return current.record
    const path = findRunPath(runId)
    if (!path) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as PackageRunRecord
  }

  function list(
    packageId?: string,
    listOptions: { includeArchived?: boolean; archived?: boolean } = {},
  ): PackageRunRecord[] {
    const workspacePath = requireWorkspace()
    const packagesRoot = join(workspacePath, '.mim', 'packages')
    if (!existsSync(packagesRoot)) return []
    const packageIds = packageId
      ? [packageId]
      : readdirSync(packagesRoot).filter(id => {
        const candidate = join(packagesRoot, id)
        return statSync(candidate).isDirectory()
      })
    const runs: PackageRunRecord[] = []
    for (const id of packageIds) {
      const dir = packageRunsDir(workspacePath, id)
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        const run = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as PackageRunRecord
        const archived = run.archived === true
        if (listOptions.archived !== undefined && archived !== listOptions.archived) continue
        if (!listOptions.includeArchived && listOptions.archived === undefined && archived) continue
        runs.push(run)
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  function archive(runId: string, archived = true): PackageRunRecord {
    const record = get(runId)
    if (!record) throw new Error(`Package run not found: ${runId}`)
    record.archived = archived
    persist(record)
    return record
  }

  function rename(runId: string, label: string): PackageRunRecord {
    const record = get(runId)
    if (!record) throw new Error(`Package run not found: ${runId}`)
    const trimmed = label.trim()
    if (!trimmed) throw new Error('Package run label cannot be empty')
    record.label = trimmed
    persist(record)
    return record
  }

  function deleteRun(runId: string): { deleted: string } {
    if (active.has(runId)) throw new Error(`Cannot delete running package run: ${runId}`)
    const path = findRunPath(runId)
    if (!path) throw new Error(`Package run not found: ${runId}`)
    unlinkSync(path)
    return { deleted: runId }
  }

  async function waitForRun(runId: string): Promise<PackageRunRecord> {
    const current = active.get(runId)
    if (!current) {
      const record = get(runId)
      if (!record) throw new Error(`Package run not found: ${runId}`)
      return record
    }
    return current.promise
  }

  function emit(record: PackageRunRecord, type: string, data?: Record<string, unknown>) {
    const event: PackageRunEvent = {
      type,
      packageId: record.packageId,
      jobId: record.jobId,
      runId: record.runId,
      ts: new Date().toISOString(),
      sequence: record.events.length + 1,
      ...(record.ephemeral ? { ephemeral: true as const } : {}),
      data,
    }
    record.events.push(event)
    options.emit?.('package:job:event', event)

    // The run is the trace: job.started opens the root span (spanId = runId),
    // every later lifecycle event nests under it. Terminal events carry the
    // run duration. Ephemeral runs leave no run record but stay in the trace —
    // housekeeping is still audit-relevant.
    const terminal = type === 'job.done' || type === 'job.failed' || type === 'job.cancelled'
    options.trace?.append({
      kind: type,
      actor: 'package',
      traceId: record.runId,
      ...(type === 'job.started' ? { spanId: record.runId } : { parentSpanId: record.runId }),
      runId: record.runId,
      packageId: record.packageId,
      subject: `${record.packageId}.${record.jobId}`,
      ...(type === 'job.failed' ? { status: 'error' as const } : terminal ? { status: 'ok' as const } : {}),
      ...(terminal ? { durationMs: Date.now() - Date.parse(record.startedAt) } : {}),
      ...(data ? { data: { ...data, ...(record.ephemeral ? { ephemeral: true } : {}) } } : record.ephemeral ? { data: { ephemeral: true } } : {}),
    })
  }

  function persist(record: PackageRunRecord): void {
    // Ephemeral runs are internal housekeeping: they live in memory while
    // active and leave no run record behind.
    if (record.ephemeral) return
    const workspacePath = requireWorkspace()
    const dir = packageRunsDir(workspacePath, record.packageId)
    mkdirSync(dir, { recursive: true })
    atomicWriteJson(join(dir, `${record.runId}.json`), record)
  }

  function findRunPath(runId: string): string | null {
    for (const run of list(undefined, { includeArchived: true })) {
      if (run.runId === runId) return join(packageRunsDir(requireWorkspace(), run.packageId), `${runId}.json`)
    }
    return null
  }

  function requireWorkspace(): string {
    const workspacePath = options.getWorkspacePath()
    if (!workspacePath) throw new Error('No workspace open')
    return workspacePath
  }

  function reconcileStaleRuns(): void {
    let records: PackageRunRecord[]
    try {
      records = list(undefined, { includeArchived: true })
    } catch {
      return
    }
    for (const record of records) {
      if (record.status !== 'running') continue
      if (active.has(record.runId)) continue
      record.status = 'failed'
      record.error = 'Interrupted by app restart'
      record.completedAt = new Date().toISOString()
      persist(record)
    }
  }

  function hasActiveRuns(): boolean {
    return active.size > 0
  }

  function activeRunCount(): number {
    return active.size
  }

  return { start, cancel, cancelAll, get, list, rename, archive, delete: deleteRun, waitForRun, reconcileStaleRuns, hasActiveRuns, activeRunCount }
}

function summarize(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 500)
  if (!value || typeof value !== 'object') return value
  return Array.isArray(value) ? { items: value.length } : { type: 'object' }
}
