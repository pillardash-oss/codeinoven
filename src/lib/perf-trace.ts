/**
 * The shape of one performance record, and the rules that bound it.
 *
 * Every operation the app performs leaves one of these on disk: a click, an IPC
 * hop, a database read, a renderer mount, a memory sample. The record answers
 * the two questions an investigation actually asks — *when* did this start, and
 * *how long* did it take — and carries enough signed context to attribute it
 * without carrying anything a user typed.
 *
 * The types live here rather than beside either writer because both ends of the
 * IPC boundary produce them and neither may import the other: main writes them
 * through its sink, the renderer batches them over `perf:records`, and main is
 * what validates every field before it reaches the file. A renderer field that
 * arrives malformed is dropped, never repaired, so a bad record can never
 * corrupt the trace that is being used to judge the app.
 */

/** A record's producer. */
export type PerfActor = 'renderer' | 'main'

/**
 * What a record describes.
 *
 * - `span` is a named operation somebody wrote by hand (`thread.open`).
 * - `ipc` is one IPC channel call, instrumented automatically at the seam.
 * - `memory` is a periodic whole-app sample: every process and its working set.
 * - `mark` is an instant with no duration (the conversation painted).
 */
export type PerfRecordKind = 'span' | 'ipc' | 'memory' | 'mark'

/** How an operation ended. */
export type PerfOutcome = 'ok' | 'error' | 'abandoned'

/** A value a record may carry as context. */
export type PerfContextValue = string | number | boolean | null

/** Attribution attached to a record, already safe to write to disk. */
export type PerfContext = Record<string, PerfContextValue>

/** The producing process's own runtime memory, when the runtime reports it. */
export interface PerfMemorySnapshot {
  rssBytes: number
  heapTotalBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}

/** One OS process of the app, as the memory sampler sees it. */
export interface PerfProcessSample {
  pid: number
  /** Electron's process type: `Browser`, `Tab`, `GPU`, `Utility`, ... */
  kind: string
  /** Working set in bytes, or null when the OS reported no sample. */
  memoryBytes: number | null
  /** CPU percentage over the last sampling window, or null when unknown. */
  cpuPercent: number | null
}

/** One line of `logs/<day>/perf.jsonl`. */
export interface PerfRecord {
  /** Unique per record, so a parent and its children can be joined. */
  id: string
  kind: PerfRecordKind
  actor: PerfActor
  /** Stable operation name: `thread.open`, `ipc:thread:loadMessages`. */
  name: string
  /** Epoch milliseconds when the operation started. */
  startedAt: number
  /** How long it took. Always >= 0. */
  durationMs: number
  outcome: PerfOutcome
  /** The span that was open when this one started, when there was one. */
  parentId?: string
  /** Attribution; values are clipped and never carry user content. */
  context?: PerfContext
  /** Failure detail, clipped. */
  error?: string
  /** The actor's own runtime memory, from runtimes that report it. */
  memory?: PerfMemorySnapshot
  /** The actor process's working set, joined from the OS by the main process. */
  processMemoryBytes?: number
  /** Every app process, present on `memory` records only. */
  processes?: PerfProcessSample[]
  /** Whole-app working set in bytes, present on `memory` records only. */
  totalMemoryBytes?: number
}

/** Longest operation name kept. Named spans are short by construction. */
export const PERF_MAX_NAME_CHARS = 120
/** Longest error string kept. */
export const PERF_MAX_ERROR_CHARS = 400
/** Longest context string value kept. */
export const PERF_MAX_CONTEXT_VALUE_CHARS = 160
/** Most context keys kept on one record. */
export const PERF_MAX_CONTEXT_KEYS = 12
/** Most records one renderer batch may carry. */
export const PERF_MAX_BATCH_RECORDS = 200
/** Most process rows kept on one memory record. */
export const PERF_MAX_PROCESS_SAMPLES = 64

const PERF_ACTORS: ReadonlySet<string> = new Set<PerfActor>(['renderer', 'main'])
const PERF_KINDS: ReadonlySet<string> = new Set<PerfRecordKind>(['span', 'ipc', 'memory', 'mark'])
const PERF_OUTCOMES: ReadonlySet<string> = new Set<PerfOutcome>(['ok', 'error', 'abandoned'])

/** Monotonic suffix so two records in the same millisecond never collide. */
let spanCounter = 0

/** One new record id. Cheap, ordered, and unique within a process. */
export function createPerfRecordId(): string {
  spanCounter = (spanCounter + 1) % Number.MAX_SAFE_INTEGER
  return `${spanCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = finiteNumber(value)
  if (parsed === null || parsed < 0) return null
  return Math.trunc(parsed)
}

/**
 * Keep the plain, bounded subset of a context object.
 *
 * A record is written to a log that is meant to be grep-able and postable, so
 * free-form text is clipped and object-shaped values are dropped outright: the
 * only values that survive are the ones a shape can describe.
 */
export function sanitizePerfContext(raw: unknown): PerfContext | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const context: PerfContext = {}
  let kept = 0
  for (const key of Object.keys(source)) {
    if (kept >= PERF_MAX_CONTEXT_KEYS) break
    const value = source[key]
    if (value === null) {
      context[clip(key, 40)] = null
      kept += 1
      continue
    }
    if (typeof value === 'boolean') {
      context[clip(key, 40)] = value
      kept += 1
      continue
    }
    if (typeof value === 'number') {
      const parsed = finiteNumber(value)
      if (parsed === null) continue
      context[clip(key, 40)] = parsed
      kept += 1
      continue
    }
    if (typeof value === 'string') {
      context[clip(key, 40)] = clip(value, PERF_MAX_CONTEXT_VALUE_CHARS)
      kept += 1
    }
  }
  return kept > 0 ? context : undefined
}

function sanitizeMemory(raw: unknown): PerfMemorySnapshot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const rssBytes = nonNegativeInteger(source['rssBytes'])
  const heapTotalBytes = nonNegativeInteger(source['heapTotalBytes'])
  const heapUsedBytes = nonNegativeInteger(source['heapUsedBytes'])
  if (rssBytes === null || heapTotalBytes === null || heapUsedBytes === null) return undefined
  return {
    rssBytes,
    heapTotalBytes,
    heapUsedBytes,
    externalBytes: nonNegativeInteger(source['externalBytes']) ?? 0,
    arrayBuffersBytes: nonNegativeInteger(source['arrayBuffersBytes']) ?? 0
  }
}

function sanitizeProcessSample(raw: unknown): PerfProcessSample | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const pid = nonNegativeInteger(source['pid'])
  if (pid === null || pid === 0) return null
  const kind = typeof source['kind'] === 'string' ? clip(source['kind'], 40) : 'unknown'
  const cpuPercent = finiteNumber(source['cpuPercent'])
  return {
    pid,
    kind,
    memoryBytes: nonNegativeInteger(source['memoryBytes']),
    cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10
  }
}

/**
 * One untrusted record, or null when it cannot be trusted.
 *
 * Everything that reaches the file passes through here on the main side, so a
 * renderer bug (a NaN duration, a missing name, a context holding a DOM node)
 * costs one dropped line instead of a corrupt trace.
 */
export function sanitizePerfRecord(raw: unknown): PerfRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const kind = source['kind']
  if (typeof kind !== 'string' || !PERF_KINDS.has(kind)) return null
  const actor = source['actor']
  if (typeof actor !== 'string' || !PERF_ACTORS.has(actor)) return null
  const outcomeRaw = source['outcome']
  const outcome: PerfOutcome =
    typeof outcomeRaw === 'string' && PERF_OUTCOMES.has(outcomeRaw)
      ? (outcomeRaw as PerfOutcome)
      : 'ok'
  const name =
    typeof source['name'] === 'string' ? clip(source['name'].trim(), PERF_MAX_NAME_CHARS) : ''
  if (!name) return null
  const startedAt = nonNegativeInteger(source['startedAt'])
  const durationMs = finiteNumber(source['durationMs'])
  if (startedAt === null || durationMs === null || durationMs < 0) return null
  const id = typeof source['id'] === 'string' && source['id'].trim() ? clip(source['id'], 64) : null
  if (!id) return null

  const record: PerfRecord = {
    id,
    kind: kind as PerfRecordKind,
    actor: actor as PerfActor,
    name,
    startedAt,
    durationMs: Math.round(durationMs * 100) / 100,
    outcome
  }
  if (typeof source['parentId'] === 'string' && source['parentId'])
    record.parentId = clip(source['parentId'], 64)
  const context = sanitizePerfContext(source['context'])
  if (context) record.context = context
  if (typeof source['error'] === 'string' && source['error'])
    record.error = clip(source['error'], PERF_MAX_ERROR_CHARS)
  const memory = sanitizeMemory(source['memory'])
  if (memory) record.memory = memory
  const processMemoryBytes = nonNegativeInteger(source['processMemoryBytes'])
  if (processMemoryBytes !== null) record.processMemoryBytes = processMemoryBytes
  const totalMemoryBytes = nonNegativeInteger(source['totalMemoryBytes'])
  if (totalMemoryBytes !== null) record.totalMemoryBytes = totalMemoryBytes
  if (Array.isArray(source['processes'])) {
    const samples: PerfProcessSample[] = []
    for (const entry of source['processes']) {
      if (samples.length >= PERF_MAX_PROCESS_SAMPLES) break
      const sample = sanitizeProcessSample(entry)
      if (sample) samples.push(sample)
    }
    if (samples.length > 0) record.processes = samples
  }
  return record
}

/**
 * A batch a renderer sent, bounded and filtered.
 *
 * The cap is what keeps a runaway loop from turning its own bug into a log that
 * cannot be opened: the first records are the ones nearest the trigger, so the
 * tail is what gets dropped.
 */
export function sanitizePerfBatch(raw: unknown): PerfRecord[] {
  if (!Array.isArray(raw)) return []
  const records: PerfRecord[] = []
  for (const entry of raw) {
    if (records.length >= PERF_MAX_BATCH_RECORDS) break
    const record = sanitizePerfRecord(entry)
    if (record) records.push(record)
  }
  return records
}

/** What `perf:memory` answers: the app's live footprint, read on request. */
export interface PerfMemoryReport {
  /** Sum of every process working set, in bytes. */
  totalBytes: number
  /** Physical memory the machine has, in bytes, when the OS reports it. */
  deviceBytes: number | null
  /** One row per app process, with its own working set and CPU share. */
  processes: PerfProcessSample[]
}

/**
 * A shipped build records only operations that were actually slow.
 *
 * The trace is a diagnostic instrument, and an instrument that writes a line for
 * every keystroke on every user's machine is background work nobody asked for.
 * In production the rule is therefore: an operation at or above this many
 * milliseconds is recorded, a failed one is recorded whatever its duration, and
 * the periodic memory sample is recorded because it is the one reading whose
 * value is in the trend rather than in any single line. Everything faster is
 * dropped at the producer, before it costs a byte.
 */
export const PERF_SLOW_RECORD_MS = 250

/** Memory-sample cadence when the full trace is on (a dev, probe or test build). */
export const PERF_MEMORY_INTERVAL_FULL_MS = 5_000

/** Memory-sample cadence in a shipped build, where only the trend matters. */
export const PERF_MEMORY_INTERVAL_PRODUCTION_MS = 60_000

/**
 * Whether one record survives the recording policy.
 *
 * `full` is the dev/probe build, which records everything. Otherwise the rule
 * above applies, and it applies identically on both sides of the IPC boundary so
 * a renderer can never flood a production trace that the main sink would keep.
 */
export function shouldRecordPerf(
  record: Pick<PerfRecord, 'kind' | 'durationMs' | 'outcome'>,
  full: boolean
): boolean {
  if (full) return true
  if (record.kind === 'memory') return true
  if (record.outcome === 'error') return true
  return record.durationMs >= PERF_SLOW_RECORD_MS
}

/**
 * A gap this long between two heartbeat ticks is a frozen renderer.
 *
 * Electron's renderer runs the UI on one thread. When that thread is busy for
 * tens of seconds — not slow, *stopped* — every promise it is waiting on resolves
 * late, so every operation appears slow by exactly the same amount, and the
 * screen keeps scrolling because scrolling is composited off that thread. The
 * trace cannot see a freeze from the inside, because the code that would record
 * it is the code that is not running. A heartbeat that notices how late it woke
 * up is what turns "everything is slow" into "the renderer stopped for 84
 * seconds, here is what it was doing".
 */
export const PERF_FREEZE_MIN_MS = 1_000

/** Whether a heartbeat gap is long enough to report as a freeze. */
export function isRenderFreeze(gapMs: number): boolean {
  return Number.isFinite(gapMs) && gapMs >= PERF_FREEZE_MIN_MS
}
