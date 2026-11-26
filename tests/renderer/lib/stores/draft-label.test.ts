// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import {
  DRAFT_LABEL_COOKIE_COALESCE_MS,
  clearDraftLabelCookie,
  deriveDraftLabel,
  draftLabelFromCookie,
  flushDraftLabelCookies,
  setDraftLabelCookie
} from '$lib/stores/draft-label'

/**
 * The draft label cookie is a convenience for surfaces that read it after a
 * navigation, and it is written from the composer on every keystroke. A
 * `document.cookie` write is synchronous and origin-wide, so the write is
 * coalesced behind the last keystroke of a burst: these pin that a burst costs
 * one write, that the last keystroke is the one that survives it, and that a
 * clear or a closing window is never overtaken by a write still waiting.
 */
describe('draft label cookie', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const threadId of ['thread-1', 'thread-2']) clearDraftLabelCookie(threadId)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes once for a burst of keystrokes, carrying the last one', () => {
    const write = vi.spyOn(document, 'cookie', 'set')

    setDraftLabelCookie('thread-1', 'R')
    setDraftLabelCookie('thread-1', 'Re')
    setDraftLabelCookie('thread-1', 'Refactor the composer')
    expect(write).not.toHaveBeenCalled()
    expect(draftLabelFromCookie('thread-1')).toBeNull()

    vi.advanceTimersByTime(DRAFT_LABEL_COOKIE_COALESCE_MS)

    expect(write).toHaveBeenCalledTimes(1)
    expect(draftLabelFromCookie('thread-1')).toBe('Refactor the composer')
  })

  it('keeps one burst per thread, so two composers never share a write', () => {
    setDraftLabelCookie('thread-1', 'First thread')
    setDraftLabelCookie('thread-2', 'Second thread')

    vi.advanceTimersByTime(DRAFT_LABEL_COOKIE_COALESCE_MS)

    expect(draftLabelFromCookie('thread-1')).toBe('First thread')
    expect(draftLabelFromCookie('thread-2')).toBe('Second thread')
  })

  it('never re-adds a label that was cleared while its burst waited', () => {
    setDraftLabelCookie('thread-1', 'A draft that was just sent')

    clearDraftLabelCookie('thread-1')
    vi.advanceTimersByTime(DRAFT_LABEL_COOKIE_COALESCE_MS)

    expect(draftLabelFromCookie('thread-1')).toBeNull()
  })

  it('clears the cookie when the burst ends with an emptied composer', () => {
    setDraftLabelCookie('thread-1', 'Something')
    vi.advanceTimersByTime(DRAFT_LABEL_COOKIE_COALESCE_MS)
    expect(draftLabelFromCookie('thread-1')).toBe('Something')

    setDraftLabelCookie('thread-1', '   \n  ')
    vi.advanceTimersByTime(DRAFT_LABEL_COOKIE_COALESCE_MS)

    expect(draftLabelFromCookie('thread-1')).toBeNull()
  })

  it('writes a waiting label when the window goes away', () => {
    setDraftLabelCookie('thread-1', 'Typed, then the window closed')

    flushDraftLabelCookies()

    expect(draftLabelFromCookie('thread-1')).toBe('Typed, then the window closed')
    const write = vi.spyOn(document, 'cookie', 'set')
    vi.advanceTimersByTime(DRAFT_LABEL_COOKIE_COALESCE_MS)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('deriveDraftLabel', () => {
  it('names a draft by the first line that survives markdown stripping', () => {
    expect(deriveDraftLabel('')).toBeNull()
    expect(deriveDraftLabel('\n\n   \n')).toBeNull()
    expect(deriveDraftLabel('# Fix the header\nSecond line')).toBe('Fix the header')
    expect(deriveDraftLabel('#\n###\n> The real first line')).toBe('The real first line')
    // Leading markdown punctuation (* is a list/bold marker) is stripped too.
    expect(deriveDraftLabel('**bold**   and   spaced')).toBe('bold** and spaced')
  })

  it('caps a long first line and marks the cut', () => {
    const label = deriveDraftLabel(`${'word '.repeat(40)}end`)
    expect(label?.endsWith('…')).toBe(true)
    expect((label ?? '').length).toBeLessThanOrEqual(49)
  })
})
