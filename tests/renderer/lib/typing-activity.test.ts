// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TYPING_WINDOW_MS,
  isTyping,
  noteKeystroke,
  resetTypingActivity
} from '$lib/typing-activity'

/**
 * The keyboard signal main reads. Nothing on screen waits for it; it exists so
 * background work a finishing thread starts (titles, summaries, memory proposals)
 * does not begin between two keystrokes.
 */
describe('typing activity', () => {
  const send = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    resetTypingActivity()
    send.mockReset()
    ;(globalThis as { window?: unknown }).window = { ...globalThis.window, api: { send } }
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

  it('tells main the keyboard is in use, at most a few times a second', () => {
    noteKeystroke()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('system:typingActivity')

    // A fast typist does not cost one IPC message per letter.
    noteKeystroke(Date.now() + 10)
    noteKeystroke(Date.now() + 20)
    expect(send).toHaveBeenCalledTimes(1)

    noteKeystroke(Date.now() + 300)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('reports nothing when main cannot be reached', () => {
    ;(globalThis as { window?: unknown }).window = { ...globalThis.window, api: undefined }
    expect(() => noteKeystroke()).not.toThrow()
    // The local signal still works, so the window's own behaviour is unaffected.
    expect(isTyping()).toBe(true)
  })
})
