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

/**
 * A frame long enough to be felt, as the browser itself accounts for it.
 *
 * `long-animation-frame` is the one measurement that names the work instead of
 * the symptom: it reports the frame's duration, how much of it was script, how
 * much was style and layout, and for each script the invoker, the function and
 * the file. A freeze recorded by the heartbeat says the renderer stopped; this
 * says what was running while it did, which is the difference between a guess
 * and an answer. Not in every Chromium build and not in TS's DOM library yet,
 * so both are declared here and the observer is only installed when the runtime
 * advertises the entry type.
 */
interface LongAnimationFrameScript {
  invoker?: string
  sourceURL?: string
  sourceFunctionName?: string
  duration?: number
}

interface LongAnimationFrameTiming {
  startTime: number
  duration: number
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: LongAnimationFrameScript[]
}

/** Frames shorter than this are normal work; only the ones a hand feels are kept. */
const LONG_FRAME_REPORT_MS = 200

/** How many scripts of one long frame are named in the trace. */
const LONG_FRAME_SCRIPT_NAMES = 3

/** The last path segment of a script URL, which is all a trace needs to place it. */
function scriptFile(sourceURL: string | undefined): string {
  if (!sourceURL) return ''
  const withoutQuery = sourceURL.split(/[?#]/, 1)[0] ?? ''
  const segments = withoutQuery.split('/')
  return segments[segments.length - 1] || withoutQuery
}

/**
 * One script's share of a long frame, as `name @ file (n ms)`.
 *
 * Flattened to a string because the trace's context holds primitives only, and
 * because a reader looking at `perf.jsonl` should not have to walk a tree to
 * see that `render` in `MarkdownView.svelte` took most of the frame.
 */
function describeLongFrameScript(script: LongAnimationFrameScript): string {
  const name = script.sourceFunctionName || script.invoker || 'anonymous'
  const file = scriptFile(script.sourceURL)
  const ms = Math.round(script.duration ?? 0)
  return file ? `${name} @ ${file} (${ms} ms)` : `${name} (${ms} ms)`
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
  /** The long-frame observer, which names the scripts inside a stall. */
  private longFrames: PerformanceObserver | null = null
  /** The memory sampler: the JS heap *and* what the window holds outside it. */
  private memoryTimer: ReturnType<typeof setInterval> | null = null
  private lastBeatAt = 0
  private installed = false

  /**
   * Start measuring as soon as this module is loaded.
   *
   * Installation used to hang off the first record, which meant the trace was
   * blind until something else happened to be measured — including on a fresh
   * renderer, where the first stall of the session is exactly the one worth
   * seeing. `install` is idempotent and a no-op without a window, so eager is
   * safe in a test or a server render too.
   */
  constructor() {
    this.install()
  }

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
    // An occluded window is not a frozen one. A background renderer has its timers
    // throttled, so this heartbeat wakes a minute late and would report a
    // minute-long "freeze" for a window nobody was looking at. Resetting the
    // baseline on every visibility change keeps those gaps out of the record, so
    // what remains is a pause that happened while the window was on screen.
    document.addEventListener('visibilitychange', () => {
      this.lastBeatAt = Date.now()
    })
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      const gap = now - this.lastBeatAt
      this.lastBeatAt = now
      if (document.hidden || document.visibilityState !== 'visible') return
      if (!isRenderFreeze(gap)) return
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize
      this.pushAt('mark', 'renderer.freeze', now - gap, gap, 'abandoned', this.currentSpanId, {
        interrupted: this.currentSpanName ?? 'idle',
        // The span named above is the one that was open, which is a hint and not a
        // verdict: an awaited span can stay open for minutes while whatever
        // stalled the thread is something else entirely.
        visibility: document.visibilityState,
        ...(typeof heap === 'number' ? { heapUsedBytes: heap } : {})
      })
    }, 250)
    this.heartbeat.unref?.()
  }

  /**
   * Record a long frame with the work that filled it.
   *
   * The heartbeat can only say the renderer stopped, and after a stall the span
   * that happens to be open is whichever one the click resumed into, which is
   * why `interrupted` reads `thread.open` for a freeze that had nothing to do
   * with opening a thread. This observer runs off the frame timeline instead, so
   * it survives the stall it reports and can attribute it: the frame's script,
   * style and layout split, and the three scripts that took the most time. A
   * frame whose script share is small and layout share is large is a DOM
   * problem; one dominated by a single named function is that function.
   */
  private startLongFrameObserver(): void {
    if (this.longFrames !== null) return
    if (typeof PerformanceObserver === 'undefined') return
    const supported = PerformanceObserver.supportedEntryTypes ?? []
    if (!supported.includes('long-animation-frame')) return
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_FRAME_REPORT_MS) continue
          this.recordLongFrame(entry as unknown as LongAnimationFrameTiming)
        }
      })
      observer.observe({ type: 'long-animation-frame', buffered: false })
      this.longFrames = observer
    } catch {
      // A runtime that will not observe must cost this measurement, never the app.
    }
  }

  /** Write one long frame, flattened to the fields a reader can act on. */
  private recordLongFrame(frame: LongAnimationFrameTiming): void {
    const scripts = [...(frame.scripts ?? [])].sort(
      (left, right) => (right.duration ?? 0) - (left.duration ?? 0)
    )
    const scriptMs = scripts.reduce((total, script) => total + (script.duration ?? 0), 0)
    const renderMs = frame.renderStart ? frame.duration - (frame.renderStart - frame.startTime) : 0
    const layoutMs = frame.styleAndLayoutStart
      ? frame.duration - (frame.styleAndLayoutStart - frame.startTime)
      : 0
    const context: PerfContext = {
      blockingMs: Math.round(frame.blockingDuration ?? 0),
      scriptMs: Math.round(scriptMs),
      renderMs: Math.round(Math.max(0, renderMs)),
      layoutMs: Math.round(Math.max(0, layoutMs)),
      scriptCount: scripts.length
    }
    scripts.slice(0, LONG_FRAME_SCRIPT_NAMES).forEach((script, index) => {
      context[`script${index + 1}`] = describeLongFrameScript(script)
    })
    // `startTime` is measured from the time origin; the trace's timeline is wall
    // clock, so the frame is placed on it before it is written.
    this.pushAt(
      'mark',
      'renderer.longframe',
      Math.round(performance.timeOrigin + frame.startTime),
      frame.duration,
      'ok',
      undefined,
      context
    )
  }

  /**
   * Record what this window costs, split by where it is held.
   *
   * A working set alone cannot say whether a renderer is fat in JavaScript or in
   * DOM, layout, strings and decoded images — and the heap snapshot answers only
   * the first half. Blink's allocators answer the second, so both are recorded
   * side by side every few seconds: a window whose JS heap is flat while its
   * partition allocator climbs is a DOM problem, and one whose discardable bytes
   * climb is holding decoded pixels.
   */
  private startMemorySampling(): void {
    if (this.memoryTimer !== null) return
    const sample = (): void => {
      try {
        const heap = (performance as Performance & { memory?: ChromiumPerformanceMemory }).memory
        const blink = window.api?.blinkMemory?.() ?? null
        const context: PerfContext = {}
        if (heap) {
          context['jsHeapUsedBytes'] = Math.trunc(heap.usedJSHeapSize)
          context['jsHeapTotalBytes'] = Math.trunc(heap.totalJSHeapSize)
        }
        if (blink) {
          context['mallocBytes'] = blink.malloc
          context['discardableBytes'] = blink.discardable
          context['partitionAllocBytes'] = blink.partitionAlloc
          context['blinkGcBytes'] = blink.blinkGc
        }
        if (Object.keys(context).length === 0) return
        this.pushAt('memory', 'renderer.memory', Date.now(), 0, 'ok', undefined, context)
      } catch {
        // A runtime that will not report must cost this sample, never the app.
      }
    }
    sample()
    this.memoryTimer = setInterval(sample, 5_000)
    this.memoryTimer.unref?.()
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
    this.startLongFrameObserver()
    this.startMemorySampling()
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
 * Record how long it took for the screen to actually show the result.
 *
 * A span ends when the code returns, which is the moment *before* the frame that
 * draws it — and the interesting question about a click is never when the
 * handler returned but when the reader saw something. Two animation frames is
 * the browser's own "this is now on the glass": the first is the frame being
 * built, the second is the one after it was presented. Nothing is recorded when
 * the window is hidden, because there is no paint to wait for and the record
 * would claim a latency nobody experienced.
 */
export function perfMarkNextPaint(name: string, context?: PerfContext): void {
  if (typeof requestAnimationFrame !== 'function') return
  const startedAt = Date.now()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      perfTracer.recordOperation({
        kind: 'mark',
        name,
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome: 'ok',
        context
      })
    })
  })
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
