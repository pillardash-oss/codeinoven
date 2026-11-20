import { describe, expect, it } from 'vitest'

import {
  agentTabIdFor,
  samePageUrl
} from '../../../src/main/browser/browser-service/browser-validation'

/**
 * A conversation's page has to be recognisable across a restart.
 *
 * The browser strip writes its rows down and restores them, while the map naming
 * each conversation's page lives in the browser process's memory. A random id
 * therefore came back as a second row for the same conversation after every
 * restart, with the old row left behind forever, which is how a project's browser
 * filled with duplicates of the same page.
 */
describe('the id of a conversation page', () => {
  it('is derived, so a restored row is the row the next open reuses', () => {
    const first = agentTabIdFor('f68bd7a8ef37b378d7da04b0', '3a76e734f4b415c64c85a239')
    const again = agentTabIdFor('f68bd7a8ef37b378d7da04b0', '3a76e734f4b415c64c85a239')
    expect(again).toBe(first)
    // The browser recognises an agent page by this prefix when it sweeps leftovers.
    expect(first.startsWith('browser:agent:')).toBe(true)
  })

  it('separates two conversations of the same project', () => {
    const one = agentTabIdFor('project', 'thread-one')
    const two = agentTabIdFor('project', 'thread-two')
    expect(one).not.toBe(two)
  })
})

describe('whether an address is the page a conversation is already on', () => {
  it('ignores the fragment and a trailing slash', () => {
    expect(samePageUrl('https://portal.azure.com/#home', 'https://portal.azure.com/')).toBe(true)
    expect(samePageUrl('https://example.com/docs/', 'https://example.com/docs')).toBe(true)
  })

  it('keeps a query, an origin and a path apart', () => {
    expect(samePageUrl('https://example.com/a', 'https://example.com/b')).toBe(false)
    expect(samePageUrl('https://example.com/a', 'https://example.com/a?tab=2')).toBe(false)
    expect(samePageUrl('https://example.com/a', 'http://example.com/a')).toBe(false)
    expect(samePageUrl('https://one.example.com/a', 'https://two.example.com/a')).toBe(false)
  })

  it('refuses to call an empty address a match', () => {
    expect(samePageUrl('', '')).toBe(false)
    expect(samePageUrl('', 'https://example.com')).toBe(false)
  })
})
