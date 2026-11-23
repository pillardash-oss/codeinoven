// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TYPING_HOLD_MAX_MS,
  TYPING_WINDOW_MS,
  isTyping,
  noteKeystroke,
  resetTypingActivity,
  whenTypingPauses
} from '$lib/typing-activity'

/**
 * Typing priority. The reported symptom is that typing stutters when a thread
 * completes; the completion's reconcile re-reads and re-renders the tail, and the
 * rule here is that it never starts between two keystrokes.
 */
describe('typing activity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    resetTypingActivity()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetTypingActivity()
  })

  it('counts a keystroke as typing only inside the window', () => {
    expect(isTyping()).toBe(false)
    noteKeystroke()
    expect(isTyping()).toBe(true)
    vi.setSystemTime(new Date(TYPING_WINDOW_MS))
    expect(isTyping()).toBe(false)
  })

  it('runs deferred work immediately when nobody is typing', async () => {
    const task = vi.fn()
    await whenTypingPauses(task)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('holds deferred work until the typing stops, then runs it once', async () => {
    const task = vi.fn()
    noteKeystroke()
    let settled = false
    void whenTypingPauses(task).then(() => (settled = true))

    // Still typing: the completion's reconcile must not run here.
    await vi.advanceTimersByTimeAsync(TYPING_WINDOW_MS / 2)
    noteKeystroke()
    expect(task).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    // Hands off the keyboard for longer than the window.
    await vi.advanceTimersByTimeAsync(TYPING_WINDOW_MS + 200)
    expect(task).toHaveBeenCalledTimes(1)
    expect(settled).toBe(true)
  })

  it('never holds work past the ceiling, even while typing continues', async () => {
    const task = vi.fn()
    noteKeystroke()
    void whenTypingPauses(task)
    // A user who types without pause still gets the conversation caught up: the
    // delay is bounded, so nothing can be starved indefinitely.
    for (let elapsed = 0; elapsed < TYPING_HOLD_MAX_MS + 400; elapsed += 100) {
      noteKeystroke()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(task).toHaveBeenCalledTimes(1)
  })
})
