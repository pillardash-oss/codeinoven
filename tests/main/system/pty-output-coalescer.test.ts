import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_OUTPUT_CHUNK_CHARS,
  PTY_OUTPUT_FLUSH_MS,
  PTY_OUTPUT_HIGH_WATER_CHARS,
  PTY_OUTPUT_LOW_WATER_CHARS,
  PtyOutputCoalescer
} from '../../../src/main/system/pty-output-coalescer'

interface FakeProcess {
  pause: () => void
  resume: () => void
  paused: boolean
  pauses: number
  resumes: number
}

function fakeProcess(): FakeProcess {
  const state: FakeProcess = {
    paused: false,
    pauses: 0,
    resumes: 0,
    pause: () => {
      state.paused = true
      state.pauses += 1
    },
    resume: () => {
      state.paused = false
      state.resumes += 1
    }
  }
  return state
}

describe('PtyOutputCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gathers one frame of small writes into a single message, in order', () => {
    const process = fakeProcess()
    const sent: string[] = []
    const output = new PtyOutputCoalescer(process, (data) => sent.push(data))

    for (const piece of ['a', 'b', 'c']) output.push(piece)
    expect(sent).toEqual([])

    vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)
    expect(sent).toEqual(['abc'])
  })

  it('sends nothing while idle, and asks for no further frames', () => {
    const process = fakeProcess()
    const sent: string[] = []
    const output = new PtyOutputCoalescer(process, (data) => sent.push(data))

    output.push('prompt$ ')
    vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)
    expect(sent).toHaveLength(1)

    // A quiet terminal must cost nothing: no timer keeps firing after a flush.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a burst in order across chunked messages', () => {
    const process = fakeProcess()
    const sent: string[] = []
    const output = new PtyOutputCoalescer(process, (data) => sent.push(data))

    const burst = 'x'.repeat(PTY_OUTPUT_CHUNK_CHARS * 2 + 10)
    output.push(burst)
    vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)

    expect(sent.join('')).toBe(burst)
    // One message per tick is capped, so the remainder waits for the next frame…
    expect(sent[0]?.length).toBe(PTY_OUTPUT_CHUNK_CHARS)
    // …and is sent by a following tick rather than dropped.
    vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)
    expect(sent.join('')).toBe(burst)
  })

  it('never splits a surrogate pair across two messages', () => {
    const process = fakeProcess()
    const sent: string[] = []
    const output = new PtyOutputCoalescer(process, (data) => sent.push(data))

    // A single astral character straddling the chunk boundary would be cut in
    // half by a naive slice; the terminal would then render two broken glyphs.
    const emoji = '😀'
    const text = `${'a'.repeat(PTY_OUTPUT_CHUNK_CHARS - 1)}${emoji}`
    output.push(text)
    vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)

    expect(sent[0]).toBe('a'.repeat(PTY_OUTPUT_CHUNK_CHARS - 1))
    expect(sent.join('')).toBe(text)
    vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)
    expect(sent.join('')).toBe(text)
  })

  it('pauses a child that outruns the frame, and resumes once drained', () => {
    const process = fakeProcess()
    const sent: string[] = []
    const output = new PtyOutputCoalescer(process, (data) => sent.push(data))

    output.push('y'.repeat(PTY_OUTPUT_HIGH_WATER_CHARS))
    expect(process.paused).toBe(true)

    // Draining happens on this timer alone, never on the renderer's answer, so
    // a hidden window can delay output but can never deadlock the child.
    while (process.paused) vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)
    expect(sent.join('').length).toBe(PTY_OUTPUT_HIGH_WATER_CHARS)
    expect(process.resumes).toBe(1)
    expect(PTY_OUTPUT_LOW_WATER_CHARS).toBeLessThan(PTY_OUTPUT_HIGH_WATER_CHARS)
  })

  it('flushes everything that is waiting ahead of an exit', () => {
    const process = fakeProcess()
    const sent: string[] = []
    const output = new PtyOutputCoalescer(process, (data) => sent.push(data))

    output.push('last words')
    output.flush()

    expect(sent).toEqual(['last words'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops waiting output and unpauses on dispose', () => {
    const process = fakeProcess()
    const sent: string[] = []
    const output = new PtyOutputCoalescer(process, (data) => sent.push(data))

    output.push('z'.repeat(PTY_OUTPUT_HIGH_WATER_CHARS))
    expect(process.paused).toBe(true)
    output.dispose()
    vi.advanceTimersByTime(PTY_OUTPUT_FLUSH_MS)

    expect(sent).toEqual([])
    expect(process.paused).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
