import type {
  PerfContext,
  PerfMemorySnapshot,
  PerfOutcome,
  PerfRecord,
  PerfRecordKind
} from '../../lib/perf-trace'
import { createPerfRecordId, sanitizePerfContext, shouldRecordPerf } from '../../lib/perf-trace'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from './logger'
import { PERF_TRACE_LOG_FILE, dailyLogRelativePath } from './log-paths'

/** The slice of storage the trace needs: one append-only sink. */
type PerfTraceStorage = Pick<StorageEngine, 'appendRaw'>

/** How long a record may wait in memory before it is written. */
const FLUSH_INTERVAL_MS = 200

/** Records held while the flush is in flight. Past this, the oldest go. */
const MAX_QUEUED_RECORDS = 4_000

/** How many records one append carries. */
const MAX_RECORDS_PER_APPEND = 200

/**
 * The performance trace sink.
 *
 * Every operation the app measures ends up as one line in the day folder's
 * `perf.jsonl` (see `src/main/system/log-paths.ts`). Writing is batched because
 * the instrumented seams are hot — one IPC call, one database read, one renderer
 * mount each add a record — and an append per record would make the measurement
 * the bottleneck it is meant to expose.
 *
 * Two rules keep the trace trustworthy rather than merely present:
 *
 * - Writing never fails a caller. A sink that cannot append drops the record and
 *   says so at `dev` level; an instrumented operation must never fail because
 *   its own telemetry did.
 * - The queue is bounded. A runaway loop produces records faster than the disk
 *   drains them, and a trace that grows without limit is one nobody can open.
 *   The oldest records are dropped first, and the count is reported once the
 *   queue drains so a truncated trace is never mistaken for a complete one.
 */
export class PerfTraceSink {
  private storage: PerfTraceStorage | null = null
  private queue: PerfRecord[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private dropped = 0
  /** Whether to also mirror slow operations into the general log. */
  private announceSlow = true
  /**
   * Whether every operation is recorded.
   *
   * A development or probe launch records everything: that is what makes a
   * regression visible before it ships. A shipped build records only what was
   * slow, because an instrument that writes a line per keystroke on every user's
   * machine is background work nobody asked for.
   */
  private fullTrace = true

  /**
   * Point the trace at the app's storage engine.
   *
   * Called once during startup, after the durable log sink exists: until then a
   * record has nowhere to go, and the trace is simply off.
   */
  initialize(storage: PerfTraceStorage): void {
    this.storage = storage
  }

  /**
   * Keep the general log told about genuinely slow operations.
   *
   * The trace itself stays in `perf.jsonl`, but an operator reading `main.jsonl`
   * should still see the one operation that took seconds without having to know
   * the trace exists. Anything under the threshold is trace-only.
   */
  announceSlowOperations(enabled: boolean): void {
    this.announceSlow = enabled
  }

  /** Choose between recording everything and recording only what was slow. */
  setFullTrace(enabled: boolean): void {
    this.fullTrace = enabled
  }

  /** Record one operation. Never throws, never blocks. */
  record(record: PerfRecord): void {
    if (!this.storage) return
    if (!shouldRecordPerf(record, this.fullTrace)) return
    if (this.queue.length >= MAX_QUEUED_RECORDS) {
      this.queue.shift()
      this.dropped += 1
    }
    this.queue.push(record)
    if (this.announceSlow && record.durationMs >= ANNOUNCE_SLOW_MS) {
      Logger.info('Slow operation', {
        operation: record.name,
        actor: record.actor,
        kind: record.kind,
        durationMs: record.durationMs,
        outcome: record.outcome
      })
    }
    this.schedule()
  }

  /** Write what is queued now. Awaited by tests and by the quit path. */
  async flush(): Promise<void> {
    if (this.flushing) return
    if (this.queue.length === 0) return
    const storage = this.storage
    if (!storage) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_RECORDS_PER_APPEND)
        const lines = batch.map((record) => `${JSON.stringify(record)}\n`).join('')
        try {
          await storage.appendRaw(dailyLogRelativePath(PERF_TRACE_LOG_FILE), lines)
        } catch (error) {
          Logger.dev('Performance trace could not be written:', error)
          return
        }
      }
      if (this.dropped > 0) {
        const dropped = this.dropped
        this.dropped = 0
        Logger.info('Performance trace dropped records', { dropped })
      }
    } finally {
      this.flushing = false
    }
  }

  /** Test seam: how many records are waiting. */
  pending(): number {
    return this.queue.length
  }

  private schedule(): void {
    if (this.timer !== null || this.flushing) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }
}

/** Operations at or above this are also named in the general log. */
const ANNOUNCE_SLOW_MS = 250

/** The one trace sink the main process writes through. */
export const perfTrace = new PerfTraceSink()

/** One open measurement on the main process. */
export interface PerfSpan {
  readonly id: string
  /** Record a phase boundary as its own child record. */
  mark(name: string, context?: PerfContext): void
  /** Close the span. Safe to call twice: the second call does nothing. */
  end(outcome?: PerfOutcome, extra?: PerfContext): void
  /** Close the span as failed, carrying the reason. */
  fail(error: unknown, extra?: PerfContext): void
}

/** The span that is currently open on this process, for parent linking. */
let currentSpanId: string | undefined

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** This process's own memory right now, or undefined where unreadable. */
export function readProcessMemory(): PerfMemorySnapshot | undefined {
  try {
    const usage = process.memoryUsage()
    return {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers
    }
  } catch {
    return undefined
  }
}

function recordAt(
  kind: PerfRecordKind,
  name: string,
  startedAt: number,
  durationMs: number,
  outcome: PerfOutcome,
  parentId: string | undefined,
  context: PerfContext | undefined,
  error?: string
): void {
  const record: PerfRecord = {
    id: createPerfRecordId(),
    kind,
    actor: 'main',
    name,
    startedAt,
    durationMs: Math.round(durationMs * 100) / 100,
    outcome
  }
  if (parentId) record.parentId = parentId
  const safeContext = sanitizePerfContext(context)
  if (safeContext) record.context = safeContext
  if (error) record.error = error
  const memory = readProcessMemory()
  if (memory) record.memory = memory
  perfTrace.record(record)
}

/**
 * Measure one named operation on the main process.
 *
 * The span links itself to whatever span is open when it starts, so a database
 * read taken inside `thread.openStreamParts` is recorded as its child instead of
 * as an unrelated line that happens to share a timestamp.
 */
export function perfSpan(name: string, context?: PerfContext): PerfSpan {
  const id = createPerfRecordId()
  const startedAt = Date.now()
  const parentId = currentSpanId
  const outer = currentSpanId
  currentSpanId = id
  let closed = false
  return {
    id,
    mark(markName: string, markContext?: PerfContext): void {
      recordAt('mark', `${name}.${markName}`, Date.now(), 0, 'ok', id, markContext)
    },
    end(outcome: PerfOutcome = 'ok', extra?: PerfContext): void {
      if (closed) return
      closed = true
      if (currentSpanId === id) currentSpanId = outer
      recordAt('span', name, startedAt, Date.now() - startedAt, outcome, parentId, {
        ...context,
        ...extra
      })
    },
    fail(error: unknown, extra?: PerfContext): void {
      if (closed) return
      closed = true
      if (currentSpanId === id) currentSpanId = outer
      recordAt(
        'span',
        name,
        startedAt,
        Date.now() - startedAt,
        'error',
        parentId,
        { ...context, ...extra },
        describeError(error)
      )
    }
  }
}

/** Measure an async main-process operation, recording its failure and rethrowing. */
export async function tracePerf<T>(
  name: string,
  context: PerfContext | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const span = perfSpan(name, context)
  try {
    const result = await operation()
    span.end()
    return result
  } catch (error) {
    span.fail(error)
    throw error
  }
}

/** Record one completed measurement taken elsewhere (an IPC handler, a seam). */
export function recordPerfOperation(input: {
  kind: PerfRecordKind
  name: string
  startedAt: number
  durationMs: number
  outcome: PerfOutcome
  context?: PerfContext
  error?: string
  parentId?: string
}): void {
  recordAt(
    input.kind,
    input.name,
    input.startedAt,
    input.durationMs,
    input.outcome,
    input.parentId,
    input.context,
    input.error
  )
}
