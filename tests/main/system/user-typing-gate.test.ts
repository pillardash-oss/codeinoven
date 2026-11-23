import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TYPING_QUIET_MAX_MS,
  TYPING_WINDOW_MS,
  isUserTyping,
  noteUserTyping,
  resetUserTyping,
  whenUserQuiet
} from '../../../src/main/system/user-typing-gate'

/**
 * The gate background model work waits on. A finishing thread starts titles,
 * summaries and memory proposals; each boots a harness process, and this app's own
 * log shows 60 auto-titles, 73 memory proposals and 182 search summaries in one
 * busy hour. None of them is worth a stutter while somebody types.
 */
describe('user typing gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(10_000))
    resetUserTyping()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetUserTyping()
  })

  it('counts the user as typing only inside the window', () => {
    expect(isUserTyping()).toBe(false)
    noteUserTyping()
    expect(isUserTyping()).toBe(true)
    vi.setSystemTime(new Date(10_000 + TYPING_WINDOW_MS))
    expect(isUserTyping()).toBe(false)
  })

  it('lets background work start at once when the keyboard is quiet', async () => {
    let started = false
    void whenUserQuiet().then(() => (started = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toBe(true)
  })

  it('holds background work while the user types, and starts it once they stop', async () => {
    let started = false
    noteUserTyping()
    void whenUserQuiet().then(() => (started = true))

    await vi.advanceTimersByTimeAsync(TYPING_WINDOW_MS / 2)
    noteUserTyping()
    expect(started).toBe(false)

    await vi.advanceTimersByTimeAsync(TYPING_WINDOW_MS + 400)
    expect(started).toBe(true)
  })

  it('never holds background work past its ceiling', async () => {
    let started = false
    noteUserTyping()
    void whenUserQuiet().then(() => (started = true))

    // A user who types without pause still gets their titles and summaries: a
    // background job can be delayed, never starved.
    for (let elapsed = 0; elapsed < TYPING_QUIET_MAX_MS + 800; elapsed += 200) {
      noteUserTyping()
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(started).toBe(true)
  })
})
