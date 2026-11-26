import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerfRecord } from '../../src/lib/perf-trace'
import { perfTrace, PerfTraceSink } from '../../src/main/system/perf-trace'
import { PERF_TRACE_LOG_FILE, logDayName } from '../../src/main/system/log-paths'

/** The append the sink performs, as the storage engine exposes it. */
type AppendRaw = (relativePath: string, content: string) => Promise<void>

/** One record shaped like a real one, with the id varied by the caller. */
function record(id: string, durationMs = 1): PerfRecord {
  return {
    id,
    kind: 'span',
    actor: 'main',
    name: 'thread.open',
    startedAt: 1_700_000_000_000,
    durationMs,
    outcome: 'ok'
  }
}

/** A storage stub that records what the sink appended. */
function appendSpy(): { appendRaw: ReturnType<typeof vi.fn<AppendRaw>> } {
  return { appendRaw: vi.fn<AppendRaw>(async () => undefined) }
}

/** Every record id the sink actually wrote, in write order. */
function writtenIds(appendRaw: ReturnType<typeof vi.fn<AppendRaw>>): string[] {
  return appendRaw.mock.calls.flatMap(([, content]) =>
    content
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as PerfRecord).id)
  )
}

describe('performance trace sink', () => {
  beforeEach(() => {
    // Announcements go through the durable Logger, which needs an initialized
    // log directory. The trace's own behaviour is what this file checks.
    perfTrace.announceSlowOperations(false)
  })

  afterEach(async () => {
    await perfTrace.flush()
    vi.restoreAllMocks()
  })

  it('writes queued records to the day folder as one JSON line each', async () => {
    const storage = appendSpy()
    perfTrace.initialize(storage)
    perfTrace.record(record('a'))
    perfTrace.record(record('b'))
    await perfTrace.flush()

    expect(storage.appendRaw).toHaveBeenCalledTimes(1)
    const [path, content] = storage.appendRaw.mock.calls[0]
    expect(path).toBe(`logs/${logDayName()}/${PERF_TRACE_LOG_FILE}`)
    expect(
      content
        .trimEnd()
        .split('\n')
        .map((line) => (JSON.parse(line) as PerfRecord).id)
    ).toEqual(['a', 'b'])
  })

  it('writes nothing when the queue is empty', async () => {
    const storage = appendSpy()
    perfTrace.initialize(storage)
    await perfTrace.flush()
    expect(storage.appendRaw).not.toHaveBeenCalled()
  })

  it('stops recording when no storage is initialized', () => {
    // A process that never started the sink (a unit test, an early failure) must
    // not accumulate records nobody can ever write.
    const fresh = new PerfTraceSink()
    fresh.record(record('ignored'))
    expect(fresh.pending()).toBe(0)
  })

  it('splits a large queue into bounded appends, keeping every record in order', async () => {
    const storage = appendSpy()
    perfTrace.initialize(storage)
    for (let index = 0; index < 450; index += 1) perfTrace.record(record(`rec-${index}`))
    await perfTrace.flush()

    expect(storage.appendRaw.mock.calls.length).toBeGreaterThan(1)
    const ids = writtenIds(storage.appendRaw)
    expect(ids).toHaveLength(450)
    expect(ids[0]).toBe('rec-0')
    expect(ids.at(-1)).toBe('rec-449')
  })

  it('drops the oldest records instead of growing without limit', async () => {
    const storage = appendSpy()
    perfTrace.initialize(storage)
    for (let index = 0; index < 5_000; index += 1) perfTrace.record(record(`rec-${index}`))
    // The queue is capped, so the newest records are the ones that survive.
    expect(perfTrace.pending()).toBeLessThanOrEqual(4_000)
    await perfTrace.flush()
    expect(writtenIds(storage.appendRaw).at(-1)).toBe('rec-4999')
  })

  it('never throws when the sink cannot append', async () => {
    const storage = {
      appendRaw: vi.fn<AppendRaw>(async () => {
        throw new Error('disk full')
      })
    }
    perfTrace.initialize(storage)
    perfTrace.record(record('a'))
    await expect(perfTrace.flush()).resolves.toBeUndefined()
  })
})
