import { describe, expect, it } from 'vitest'
import {
  MAX_BROWSER_TAB_ASSISTANT_THREADS,
  parseGlobalBrowserTabsSnapshot
} from '../../src/lib/browser/global-browser-tabs'

/**
 * One page can be asked more than one thing, so a browser tab owns a list of
 * assistant conversations rather than a single one. The stored list has to
 * survive a tab written by an earlier build (which held one id), and it has to be
 * bounded and repaired like every other stored field.
 */
describe('stored browser tab assistant conversations', () => {
  const tab = (extra: Record<string, unknown>): Record<string, unknown> => ({
    id: 'browser:e31c1b2a-2fe7-4d1e-ab47-09036dcd7811',
    title: 'A page',
    url: 'https://example.com/',
    createdAt: 1,
    lastUsedAt: 1,
    ...extra
  })

  function conversationsOf(entry: Record<string, unknown>): string[] {
    const parsed = parseGlobalBrowserTabsSnapshot({ tabs: [entry] })
    return parsed.tabs[0]?.assistantThreadIds ?? []
  }

  it('keeps every conversation a tab owns, in order', () => {
    expect(
      conversationsOf(
        tab({
          assistantThreadIds: ['browser-tab', 'browser-tab-1a2b3c4d', 'browser-tab-deadbeef']
        })
      )
    ).toEqual(['browser-tab', 'browser-tab-1a2b3c4d', 'browser-tab-deadbeef'])
  })

  it('reads the single id an earlier build stored as a one-conversation list', () => {
    expect(conversationsOf(tab({ assistantThreadId: 'browser-tab' }))).toEqual(['browser-tab'])
  })

  it('drops unusable ids without losing the rest', () => {
    expect(
      conversationsOf(
        tab({ assistantThreadIds: ['browser-tab', '../../escape', '', 'browser-tab', 42] })
      )
    ).toEqual(['browser-tab'])
  })

  it('bounds the list a tab may carry', () => {
    const many = Array.from({ length: MAX_BROWSER_TAB_ASSISTANT_THREADS + 5 }, (_, i) => `b${i}`)
    expect(conversationsOf(tab({ assistantThreadIds: many }))).toHaveLength(
      MAX_BROWSER_TAB_ASSISTANT_THREADS
    )
  })
})
