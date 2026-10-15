import { describe, expect, it } from 'vitest'
import { isReservedBrowserAction } from '../../../src/main/browser/browser-service/browser-shortcuts'
import { validateBrowserAppShortcutChords } from '../../../src/main/browser/browser-service/browser-validation'

/**
 * The reserved/overridable split decides which browser chords the app claims in a
 * page before the page sees them. A reserved chord is one no page can answer and
 * which the application menu would otherwise take (a reload, a tab close), so it
 * is always claimed. `savePage` is the one the user may let a site override.
 */
describe('isReservedBrowserAction', () => {
  it('reserves the chords a page cannot answer', () => {
    for (const action of [
      'reload',
      'hardReload',
      'back',
      'forward',
      'focusAddress',
      'zoomIn',
      'zoomOut',
      'zoomReset',
      'toggleDevTools',
      'closeTab',
      'newTab',
      'reopenTab'
    ] as const) {
      expect(isReservedBrowserAction(action)).toBe(true)
    }
  })

  it('lets a page override Save', () => {
    expect(isReservedBrowserAction('savePage')).toBe(false)
  })
})

describe('validateBrowserAppShortcutChords', () => {
  const chord = { key: 'k', meta: true, control: false, shift: false, alt: false }

  it('refuses a value that is not a list', () => {
    expect(() => validateBrowserAppShortcutChords(chord)).toThrow()
  })

  it('refuses a chord with a missing or non-boolean modifier', () => {
    expect(() =>
      validateBrowserAppShortcutChords([{ key: 'k', meta: true, control: false, shift: false }])
    ).toThrow()
    expect(() =>
      validateBrowserAppShortcutChords([{ ...chord, alt: 'no' }])
    ).toThrow()
  })

  it('refuses a chord with an unbounded key', () => {
    expect(() => validateBrowserAppShortcutChords([{ ...chord, key: '' }])).toThrow()
    expect(() => validateBrowserAppShortcutChords([{ ...chord, key: 'k'.repeat(64) }])).toThrow()
  })

  it('caps the whole registry so a bad caller cannot force a huge scan', () => {
    const many = Array.from({ length: 600 }, () => chord)
    expect(() => validateBrowserAppShortcutChords(many)).toThrow()
  })

  it('normalizes a key to lowercase, which is how the events match', () => {
    expect(validateBrowserAppShortcutChords([{ ...chord, key: 'K' }])[0].key).toBe('k')
  })
})
