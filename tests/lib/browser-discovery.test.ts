import { describe, expect, it } from 'vitest'

import { browserSearchEntry, matchesBrowserSearchIntent } from '../../src/lib/browser-discovery'

/**
 * A page question must name the in-app browser.
 *
 * A thread asked to prove a delete flow concluded the session had no browser,
 * opened its own Playwright chromium plus a second dev server, and reported
 * evidence from an origin the user was not watching. The browser was installed
 * the whole time; the search ranked utilities and never named it. These
 * assertions hold the answer that stops that: the intent is recognised, the
 * entry carries the real id, the real operations, and says it is installed.
 */
describe('the in-app browser in a capability search', () => {
  it('is named for the phrasings a model actually types', () => {
    for (const query of [
      'browser tool',
      'take a screenshot of localhost:5173',
      'check the console for errors',
      'click the delete button on the page',
      'navigate to the admin dashboard',
      'open the app in a tab',
      'inspect the rendered page'
    ]) {
      expect(matchesBrowserSearchIntent(query), query).toBe(true)
    }
  })

  it('stays out of a search that is not about a page', () => {
    for (const query of ['postgres backup', 'image descriptor', 'svelte runes']) {
      expect(matchesBrowserSearchIntent(query), query).toBe(false)
    }
  })

  it('hands back the installed utility, its id and the operations that do the work', () => {
    const entry = browserSearchEntry()
    expect(entry.id).toBe('cio:browser')
    expect(entry.activateWith).toBe('cio_util_init')
    expect(entry.callDirectly).toBe(false)
    for (const operation of [
      'open',
      'navigate',
      'run',
      'snapshot',
      'query',
      'screenshot',
      'console',
      'click',
      'type',
      'evaluate',
      'wait'
    ]) {
      expect(entry.description, operation).toContain(operation)
    }
    // The one thing it must never suggest as an alternative.
    expect(entry.description).toContain('Never launch chromium')
  })
})
