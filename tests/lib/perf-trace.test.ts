import { describe, expect, it } from 'vitest'
import {
  PERF_MAX_BATCH_RECORDS,
  PERF_MAX_CONTEXT_KEYS,
  PERF_MAX_CONTEXT_VALUE_CHARS,
  PERF_MAX_NAME_CHARS,
  PERF_MAX_PROCESS_SAMPLES,
  createPerfRecordId,
  sanitizePerfBatch,
  sanitizePerfContext,
  sanitizePerfRecord
} from '../../src/lib/perf-trace'

/** A minimal valid record, so each test can break exactly one field. */
function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rec-1',
    kind: 'span',
    actor: 'renderer',
    name: 'thread.open',
    startedAt: 1_700_000_000_000,
    durationMs: 12.5,
    outcome: 'ok',
    ...overrides
  }
}

describe('perf record ids', () => {
  it('never repeats an id inside one process', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 2_000; index += 1) ids.add(createPerfRecordId())
    expect(ids.size).toBe(2_000)
  })
})

describe('sanitizePerfRecord', () => {
  it('keeps a well-formed record and rounds its duration', () => {
    const record = sanitizePerfRecord(baseRecord({ durationMs: 12.3456 }))
    expect(record).not.toBeNull()
    expect(record?.name).toBe('thread.open')
    expect(record?.durationMs).toBe(12.35)
    expect(record?.outcome).toBe('ok')
  })

  it('rejects a record without a usable identity', () => {
    expect(sanitizePerfRecord(baseRecord({ id: '' }))).toBeNull()
    expect(sanitizePerfRecord(baseRecord({ name: '   ' }))).toBeNull()
  })

  it('rejects unknown kinds, actors and negative durations', () => {
    expect(sanitizePerfRecord(baseRecord({ kind: 'guess' }))).toBeNull()
    expect(sanitizePerfRecord(baseRecord({ actor: 'gpu' }))).toBeNull()
    expect(sanitizePerfRecord(baseRecord({ durationMs: -1 }))).toBeNull()
    expect(sanitizePerfRecord(baseRecord({ durationMs: Number.NaN }))).toBeNull()
    expect(sanitizePerfRecord(baseRecord({ startedAt: -5 }))).toBeNull()
  })

  it('falls back to ok for an outcome it cannot read', () => {
    expect(sanitizePerfRecord(baseRecord({ outcome: 'weird' }))?.outcome).toBe('ok')
  })

  it('clips an overlong name instead of dropping the record', () => {
    const name = 'x'.repeat(PERF_MAX_NAME_CHARS * 2)
    expect(sanitizePerfRecord(baseRecord({ name }))?.name).toHaveLength(PERF_MAX_NAME_CHARS)
  })

  it('keeps a bounded process sample list and drops malformed rows', () => {
    const processes = Array.from({ length: PERF_MAX_PROCESS_SAMPLES + 5 }, (_unused, index) => ({
      pid: index + 1,
      kind: 'Tab',
      memoryBytes: 1024,
      cpuPercent: 1.5
    }))
    processes.push({ pid: 0, kind: 'Tab', memoryBytes: 1, cpuPercent: 0 } as never)
    const record = sanitizePerfRecord(baseRecord({ kind: 'memory', processes }))
    expect(record?.processes).toHaveLength(PERF_MAX_PROCESS_SAMPLES)
    expect(record?.processes?.every((entry) => entry.pid > 0)).toBe(true)
  })

  it('drops a memory snapshot that is not fully readable', () => {
    expect(
      sanitizePerfRecord(
        baseRecord({ memory: { rssBytes: 10, heapTotalBytes: 5, heapUsedBytes: Number.NaN } })
      )?.memory
    ).toBeUndefined()
    expect(
      sanitizePerfRecord(
        baseRecord({ memory: { rssBytes: 10, heapTotalBytes: 5, heapUsedBytes: 2 } })
      )?.memory?.heapUsedBytes
    ).toBe(2)
  })
})

describe('sanitizePerfContext', () => {
  it('keeps primitives, clips strings, and drops objects', () => {
    const context = sanitizePerfContext({
      cold: true,
      window: 100,
      projectId: 'p1',
      missing: null,
      big: 'y'.repeat(PERF_MAX_CONTEXT_VALUE_CHARS * 3),
      nested: { a: 1 },
      list: [1, 2, 3]
    })
    expect(context).toEqual({
      cold: true,
      window: 100,
      projectId: 'p1',
      missing: null,
      big: 'y'.repeat(PERF_MAX_CONTEXT_VALUE_CHARS)
    })
  })

  it('bounds how many keys one record carries', () => {
    const wide: Record<string, number> = {}
    for (let index = 0; index < PERF_MAX_CONTEXT_KEYS + 8; index += 1) wide[`k${index}`] = index
    expect(Object.keys(sanitizePerfContext(wide) ?? {})).toHaveLength(PERF_MAX_CONTEXT_KEYS)
  })

  it('answers undefined when nothing survives', () => {
    expect(sanitizePerfContext({ nested: { a: 1 } })).toBeUndefined()
    expect(sanitizePerfContext(null)).toBeUndefined()
    expect(sanitizePerfContext([1, 2])).toBeUndefined()
  })
})

describe('sanitizePerfBatch', () => {
  it('drops malformed entries and keeps the order of the rest', () => {
    const batch = sanitizePerfBatch([
      baseRecord({ id: 'a', name: 'first' }),
      { nope: true },
      baseRecord({ id: 'b', name: 'second' })
    ])
    expect(batch.map((record) => record.name)).toEqual(['first', 'second'])
  })

  it('caps how many records one batch may carry', () => {
    const raw = Array.from({ length: PERF_MAX_BATCH_RECORDS + 25 }, (_unused, index) =>
      baseRecord({ id: `rec-${index}` })
    )
    expect(sanitizePerfBatch(raw)).toHaveLength(PERF_MAX_BATCH_RECORDS)
  })

  it('answers an empty batch for a value that is not a list', () => {
    expect(sanitizePerfBatch(undefined)).toEqual([])
    expect(sanitizePerfBatch({ records: [] })).toEqual([])
  })
})
