import type { PerfContext, PerfOutcome, PerfRecord, PerfRecordKind } from '$shared/perf-trace'
import {
  createPerfRecordId,
  isRenderFreeze,
  sanitizePerfContext,
  shouldRecordPerf
} from '$shared/perf-trace'
import { PERF_RECORDS_SEND_CHANNEL } from '$shared/ipc-contract'
import type { AppBridge } from '../../preload/index'

declare global {
  interface Window {
    api: AppBridge
  }
}

/**
 * Renderer-side performance tracing.
 *
 * The renderer is where the app *feels* slow, and it was the one layer with no
 * measurements at all: main had slow-SQL warnings, but nothing recorded when a
 * click started, how long the conversation took to mount, or which of the six
 * reads an open performs was the one that stalled. Every renderer measurement
 * lands in `logs/<day>/perf.jsonl` beside the main-process ones, so one file
 * holds the whole timeline of an interaction.
 *
 * Three rules make it usable rather than merely present:
 *
 * - Measurement never blocks. Records are batched and handed over with `send`,
 *   never awaited. An instrumented operation pays two `Date.now()` calls and an
 *   array push; it never waits on the trace.
 * - Measurement never fails a caller. A tracer that cannot queue or send drops
 *   the record. Nothing here throws into the operation being measured.
 * - Volume is bounded. A runaway loop produces records faster than any disk will
 *   take them, so the queue is capped and the oldest go first — a trace nobody
 *   can open is worse than a truncated one.
 */

/** How long a record waits before the batch is handed over. */
const FLUSH_INTERVAL_MS = 500

/** Records held before a flush. Past this, the oldest are dropped. */
const MAX_QUEUED_RECORDS = 500

/** How many records are dropped silently before the loss is reported. */
const DROP_REPORT_THRESHOLD = 50

/** Chromium's own heap counters, which it exposes on `performance`. */
interface ChromiumPerformanceMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
}

/** The renderer runtime's heap numbers, when this Chromium build reports them. */
function rendererHeapContext(): PerfContext | undefined {
  const runtime = performance as Performance & { memory?: ChromiumPerformanceMemory }
  const memory = runtime.memory
  if (!memory) return undefined
  return {
    jsHeapUsedBytes: Math.trunc(memory.usedJSHeapSize),
    jsHeapTotalBytes: Math.trunc(memory.totalJSHeapSize)
  }
}

/** One open measurement in the renderer. */
export interface PerfSpan {
  readonly id: string
  /** Record a phase boundary as its own child record, for splitting a span up. */
  mark(name: string, context?: PerfContext): void
  /** Close the span. Safe to call twice; the second call does nothing. */
  end(outcome?: PerfOutcome, extra?: PerfContext): void
  /** Close the span as failed, carrying the reason. */
  fail(error: unknown, extra?: PerfContext): void
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'Unknown failure'
}

class PerfTracer {
  private queue: PerfRecord[] = []
  /**
   * Whether this build records every operation.
   *
   * Read from the build environment the preload already resolved, so the renderer
   * applies exactly the rule the main sink applies. Without this a production
   * window would keep measuring every click and hand the records to a sink that
   * drops them, paying the whole cost of the trace for none of it.
   */
  private readonly fullTrace: boolean =
    typeof window === 'undefined' || window.api?.windowInfo.buildEnvironment !== 'production'
  private timer: ReturnType<typeof setTimeout> | null = null
  private dropped = 0
  /** The span that is open right now, for linking children to their parent. */
  private currentSpanId: string | undefined
  /** The open span's name, so a freeze can name what it interrupted. */
  private currentSpanName: string | undefined
  /** How often the heartbeat checks whether the renderer stopped running. */
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastBeatAt = 0
  private installed = false

  /**
   * Queue one record.
   *
   * Records are dropped, never thrown, when the renderer has no bridge (a unit
   * test, a document without the preload) or the queue is full.
   */
  record(record: PerfRecord): void {
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (!bridge) return
    if (!shouldRecordPerf(record, this.fullTrace)) return
    if (this.queue.length >= MAX_QUEUED_RECORDS) {
      this.queue.shift()
      this.dropped += 1
    }
    this.queue.push(record)
    this.install()
    this.schedule()
  }

  /** Hand the queue to main now. Called by the timer and by the unload hooks. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    const dropped = this.dropped
    this.dropped = 0
    try {
      window.api.send(PERF_RECORDS_SEND_CHANNEL, batch)
    } catch {
      // A closed window has nowhere to send to. The records are already gone
      // from the queue; losing them is the only option and it costs nothing the
      // user can see.
      return
    }
    if (dropped >= DROP_REPORT_THRESHOLD) {
      // The loss has to be visible in the trace itself, or a run that dropped
      // half its records looks like a run that was simply quiet.
      this.queue.push({
        id: createPerfRecordId(),
        kind: 'mark',
        actor: 'renderer',
        name: 'perf.records.dropped',
        startedAt: Date.now(),
        durationMs: 0,
        outcome: 'abandoned',
        context: { dropped }
      })
      this.schedule()
    }
  }

  /** How many records are waiting. A test seam. */
  pending(): number {
    return this.queue.length
  }

  /**
   * Link a child record to the span that is open.
   *
   * Returns undefined when nothing is open, so a record taken outside any span
   * is recorded as a root instead of being attached to an unrelated one.
   */
  currentParent(): string | undefined {
    return this.currentSpanId
  }

  setCurrentSpan(id: string | undefined, name?: string): void {
    this.currentSpanId = id
    this.currentSpanName = name
  }

  /** Write a record that has no duration. */
  mark(name: string, context?: PerfContext): void {
    this.pushAt('mark', name, Date.now(), 0, 'ok', undefined, context)
  }

  /** Write one completed measurement taken at a seam (an IPC call, a load). */
  recordOperation(input: {
    kind: PerfRecordKind
    name: string
    startedAt: number
    durationMs: number
    outcome: PerfOutcome
    context?: PerfContext
    error?: string
    parentId?: string
  }): void {
    this.pushAt(
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

  /**
   * Open a named span.
   *
   * The span becomes the parent of every record taken while it runs, so a single
   * click reads as one tree in the trace instead of a pile of unrelated lines
   * that happen to share a timestamp.
   */
  span(name: string, context?: PerfContext): PerfSpan {
    const id = createPerfRecordId()
    const startedAt = Date.now()
    const parentId = this.currentSpanId
    const outer = this.currentSpanId
    const outerName = this.currentSpanName
    this.currentSpanId = id
    this.currentSpanName = name
    let closed = false
    const close = (outcome: PerfOutcome, error?: string, extra?: PerfContext): void => {
      if (closed) return
      closed = true
      if (this.currentSpanId === id) {
        this.currentSpanId = outer
        this.currentSpanName = outerName
      }
      this.pushAt(
        'span',
        name,
        startedAt,
        Date.now() - startedAt,
        outcome,
        parentId,
        { ...context, ...extra },
        error
      )
    }
    return {
      id,
      mark: (markName: string, markContext?: PerfContext): void => {
        this.pushAt('mark', `${name}.${markName}`, Date.now(), 0, 'ok', id, markContext)
      },
      end: (outcome: PerfOutcome = 'ok', extra?: PerfContext): void =>
        close(outcome, undefined, extra),
      fail: (error: unknown, extra?: PerfContext): void =>
        close('error', describeError(error), extra)
    }
  }

  private pushAt(
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
      actor: 'renderer',
      name,
      startedAt,
      durationMs: Math.round(durationMs * 100) / 100,
      outcome
    }
    if (parentId) record.parentId = parentId
    const merged = sanitizePerfContext({ ...context, ...rendererHeapContext() })
    if (merged) record.context = merged
    if (error) record.error = error
    this.record(record)
  }

  /**
   * Notice when the UI thread stopped running.
   *
   * A frozen renderer cannot record its own freeze while it is frozen, so this
   * heartbeat measures how late it woke up instead. A gap of a second or more is
   * recorded as `renderer.freeze`, with the span that was open when the thread
   * stalled — which is the only evidence a freeze leaves, and the thing that
   * turns "everything is slow at once" into one operation to look at.
   */
  private startHeartbeat(): void {
    if (this.heartbeat !== null) return
    this.lastBeatAt = Date.now()
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      const gap = now - this.lastBeatAt
      this.lastBeatAt = now
      if (!isRenderFreeze(gap)) return
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize
      this.pushAt('mark', 'renderer.freeze', now - gap, gap, 'abandoned', this.currentSpanId, {
        interrupted: this.currentSpanName ?? 'idle',
        ...(typeof heap === 'number' ? { heapUsedBytes: heap } : {})
      })
    }, 250)
    this.heartbeat.unref?.()
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_INTERVAL_MS)
  }

  /**
   * Flush on the way out.
   *
   * A quit, a reload or a parked window would otherwise lose up to one batch of
   * records — which is exactly the tail of the interaction being investigated.
   */
  private install(): void {
    if (this.installed || typeof window === 'undefined') return
    this.installed = true
    this.startHeartbeat()
    window.addEventListener('pagehide', () => this.flush())
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.flush()
    })
  }
}

/** The one tracer the renderer writes through. */
export const perfTracer = new PerfTracer()

/** Measure one named renderer operation. */
export function perfSpan(name: string, context?: PerfContext): PerfSpan {
  return perfTracer.span(name, context)
}

/** Write an instant on the renderer timeline. */
export function perfMark(name: string, context?: PerfContext): void {
  perfTracer.mark(name, context)
}

/** Measure an async renderer operation, recording its failure and rethrowing. */
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

/**
 * Time one IPC call from the renderer's side.
 *
 * The difference between this number and the main-side one for the same channel
 * is the cost the renderer actually pays and the handler does not: waiting for
 * the feature graph, structured-cloning the arguments, crossing the boundary,
 * and queueing behind whatever else the main process is doing.
 */
export function recordPerfInvoke(
  channel: string,
  startedAt: number,
  outcome: PerfOutcome,
  error?: string
): void {
  perfTracer.recordOperation({
    kind: 'ipc',
    name: `ipc:${channel}`,
    startedAt,
    durationMs: Date.now() - startedAt,
    outcome,
    context: { side: 'renderer' },
    ...(error === undefined ? {} : { error })
  })
}
