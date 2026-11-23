import { describe, expect, it } from 'vitest'
import { threadWindowPlan, threadWindowCount } from '../../src/main/search/thread-search-summary'
import { decodeThreadIndex, encodeThreadIndex } from '../../src/lib/search/vector'
import type { ThreadEmbeddingRecord } from '../../src/lib/search/types'

/**
 * A settled run must not re-embed a conversation it already indexed.
 *
 * Window offsets used to be a pure function of the thread's size, so appending ten
 * characters to a 20,000-character thread moved four of its five windows, changed
 * their text, changed their content hashes, and re-embedded all of them: ~12 s of
 * one core per turn for a six-window thread (measured at 2.05 s for a 4 K window).
 * These tests pin the frozen plan that fixes it, and the record version that
 * carries it.
 */

const WIDTH = 4096
const MAX_WINDOWS = 6

/** Which windows of a re-plan would have to be embedded again. */
function changedWindows(
  before: { plannedTotal: number; offsets: number[] },
  after: { plannedTotal: number; offsets: number[] },
  total: number
): number[] {
  const changed: number[] = []
  const count = Math.max(before.offsets.length, after.offsets.length)
  for (let index = 0; index < count; index += 1) {
    const previous = before.offsets[index]
    const next = after.offsets[index]
    if (next === undefined || previous === undefined || previous !== next) {
      changed.push(index)
      continue
    }
    // Same offset but different available text still changes the document: the
    // last window is clipped to the end of the conversation.
    if (index === count - 1 && total !== before.plannedTotal) changed.push(index)
  }
  return changed
}

describe('thread window plan', () => {
  it('keeps every window but the newest one where it was when a long thread grows', () => {
    const total = 20_000
    const before = threadWindowPlan(total, WIDTH, MAX_WINDOWS, 0)
    expect(before.offsets.length).toBe(5)

    // One more message: ten characters, the size of a sentence fragment.
    const after = threadWindowPlan(total + 10, WIDTH, MAX_WINDOWS, before.plannedTotal)
    expect(after.offsets.length).toBe(5)
    expect(after.offsets.slice(0, 4)).toEqual(before.offsets.slice(0, 4))
    // The last window follows the newest text, which is the only content that
    // actually changed.
    expect(after.offsets[4]).toBe(total + 10 - WIDTH)
    expect(changedWindows(before, after, total + 10)).toEqual([4])
  })

  it('costs one embedding per turn on a thread at the window cap, not six', () => {
    // The live corpus averages 810 K characters per thread, where the six-window
    // cap is always reached.
    const total = 810_000
    const before = threadWindowPlan(total, WIDTH, MAX_WINDOWS, 0)
    expect(before.offsets.length).toBe(MAX_WINDOWS)

    let plan = before
    for (const growth of [5_000, 5_000, 5_000, 5_000]) {
      const next = threadWindowPlan(total + growth, WIDTH, MAX_WINDOWS, plan.plannedTotal)
      expect(changedWindows(plan, next, total + growth)).toEqual([MAX_WINDOWS - 1])
      plan = next
    }
  })

  it('re-spreads once the thread has grown past one window spacing', () => {
    const total = 810_000
    const before = threadWindowPlan(total, WIDTH, MAX_WINDOWS, 0)
    const spacing = Math.floor((total - WIDTH) / (MAX_WINDOWS - 1))
    // Growth inside one spacing keeps the plan; past it, the spread is redone so
    // the sampled region never lags by more than the gap it already has.
    const inside = threadWindowPlan(total + spacing, WIDTH, MAX_WINDOWS, before.plannedTotal)
    expect(inside.plannedTotal).toBe(total)
    const past = threadWindowPlan(total + spacing + 1, WIDTH, MAX_WINDOWS, before.plannedTotal)
    expect(past.plannedTotal).toBe(total + spacing + 1)
    expect(past.offsets[0]).toBe(0)
    expect(past.offsets[past.offsets.length - 1]).toBe(total + spacing + 1 - WIDTH)
  })

  it('re-plans when the thread gains a window or loses text', () => {
    const total = 20_000
    const before = threadWindowPlan(total, WIDTH, MAX_WINDOWS, 0)
    // A shrink is an edit, not an append: the offsets no longer describe it.
    const shrunk = threadWindowPlan(total - 5_000, WIDTH, MAX_WINDOWS, before.plannedTotal)
    expect(shrunk.plannedTotal).toBe(total - 5_000)
    // Crossing into another window re-plans rather than leaving the tail to carry
    // content a further window should describe.
    const grown = threadWindowPlan(MAX_WINDOWS * WIDTH, WIDTH, MAX_WINDOWS, before.plannedTotal)
    expect(grown.offsets.length).toBe(MAX_WINDOWS)
    expect(threadWindowCount(MAX_WINDOWS * WIDTH, WIDTH, MAX_WINDOWS)).toBe(MAX_WINDOWS)
  })

  it('plans a thread shorter than one window as a single window at the start', () => {
    const plan = threadWindowPlan(1_200, WIDTH, MAX_WINDOWS, 0)
    expect(plan.offsets).toEqual([0])
    expect(threadWindowPlan(0, WIDTH, MAX_WINDOWS, 0).offsets).toEqual([0])
  })

  it('never places a window past the text it describes', () => {
    let total = 5_000
    let plan = threadWindowPlan(total, WIDTH, MAX_WINDOWS, 0)
    for (let turn = 0; turn < 60; turn += 1) {
      total += 4_000
      plan = threadWindowPlan(total, WIDTH, MAX_WINDOWS, plan.plannedTotal)
      for (const offset of plan.offsets) {
        expect(offset).toBeGreaterThanOrEqual(0)
        expect(offset).toBeLessThanOrEqual(Math.max(0, total - WIDTH))
      }
      for (let index = 1; index < plan.offsets.length; index += 1) {
        expect(plan.offsets[index]).toBeGreaterThanOrEqual(plan.offsets[index - 1])
      }
    }
  })
})

describe('thread index record', () => {
  const record: ThreadEmbeddingRecord = {
    threadId: 'thread-1',
    dimensions: 3,
    updatedAt: 1_700_000_000_000,
    windows: [
      { vector: new Float32Array([1, 0, 0]), contentHash: 'a' },
      { vector: new Float32Array([0, 1, 0]), contentHash: 'b' }
    ],
    planned: 2,
    width: WIDTH,
    plannedTotal: 40_000
  }

  it('round-trips the planned size', () => {
    const decoded = decodeThreadIndex(encodeThreadIndex([record]))
    expect(decoded).not.toBeNull()
    expect(decoded?.[0]?.plannedTotal).toBe(40_000)
    expect(decoded?.[0]?.windows.map((window) => window.contentHash)).toEqual(['a', 'b'])
  })

  it('reads a version-4 blob as unplanned instead of discarding the index', () => {
    const current = encodeThreadIndex([record])
    // Rebuild the same record in the version-4 layout: no planned size field.
    const v4 = new Uint8Array(current.byteLength - 4)
    v4.set(current.subarray(0, 12), 0)
    const v4View = new DataView(v4.buffer)
    v4View.setUint32(4, 4, false)
    v4View.setUint32(8, 1, false)
    let read = 12
    let write = 12
    const idBytes = new TextEncoder().encode(record.threadId)
    v4.set(current.subarray(read, read + 4 + idBytes.length), write)
    read += 4 + idBytes.length
    write += 4 + idBytes.length
    v4.set(current.subarray(read, read + 16), write)
    read += 16
    write += 16
    // Skip the version-5 planned size and copy the window section behind it.
    read += 4
    v4.set(current.subarray(read), write)

    const decoded = decodeThreadIndex(v4)
    expect(decoded).not.toBeNull()
    expect(decoded?.[0]?.plannedTotal).toBe(0)
    expect(decoded?.[0]?.windows).toHaveLength(2)
    expect(decoded?.[0]?.planned).toBe(2)
  })
})
