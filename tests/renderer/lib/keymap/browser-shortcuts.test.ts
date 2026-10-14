// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { browserShortcutBindings, browserSwitcherChords } from '$lib/keymap/browser-shortcuts'
import { keymapKeys } from '$lib/keymap/keymap'

/** The registry's effective keys, which is what the live keymap store answers
 *  for a shortcut the user has not rebound. */
const source = { keysFor: (id: string) => keymapKeys(id) }

/** Pin the platform the way the Electron bridge does, so `isMacPlatform` (and
 *  every platform-aware key resolution behind it) sees the platform under test. */
function setPlatform(platform: string): void {
  Object.defineProperty(window, 'api', {
    value: { windowInfo: { platform } },
    configurable: true
  })
}

function claimedChords(platform: string): ReturnType<typeof browserShortcutBindings> {
  setPlatform(platform)
  return browserShortcutBindings(source)
}

function hasChord(
  platform: string,
  wanted: { key: string; meta?: boolean; control?: boolean; alt?: boolean }
): boolean {
  return Object.values(claimedChords(platform))
    .flat()
    .some(
      (chord) =>
        chord.key === wanted.key &&
        chord.meta === Boolean(wanted.meta) &&
        chord.control === Boolean(wanted.control) &&
        chord.alt === Boolean(wanted.alt)
    )
}

describe('browserShortcutBindings', () => {
  it('claims the browser chords a page cannot answer, on macOS', () => {
    // Reload, close the tab and focus the address bar are chords a normal browser
    // reserves. A page holds the keyboard through its own view, so without these
    // the key would reach the application menu instead of acting on the page.
    expect(hasChord('darwin', { key: 'r', meta: true })).toBe(true)
    expect(hasChord('darwin', { key: 'w', meta: true })).toBe(true)
    expect(hasChord('darwin', { key: 'l', meta: true })).toBe(true)
    expect(hasChord('darwin', { key: '=', meta: true })).toBe(true)
  })

  it('claims the browser chords a page cannot answer, on Windows and Linux', () => {
    expect(hasChord('win32', { key: 'r', control: true })).toBe(true)
    expect(hasChord('linux', { key: 'w', control: true })).toBe(true)
  })

  it('leaves find to a page that draws its own, every platform', () => {
    // A page that draws its own find (Figma, Docs) must keep `mod+f`; the app
    // must never claim it first. `mod+g` and `mod+shift+g` are the same find
    // session stepping, so they stay with the page too. Find still opens from
    // the browser's own chrome, where the renderer answers it itself.
    for (const platform of ['darwin', 'linux', 'win32']) {
      const keys = Object.values(claimedChords(platform))
        .flat()
        .map((chord) => chord.key)
      expect(keys).not.toContain('f')
      expect(keys).not.toContain('g')
    }
  })

  it('never claims an app shortcut from a page', () => {
    // The spotlight, a new thread, a view switch and the sidebar toggles are the
    // app's own. While a page holds the keyboard the page wins, so none of them
    // is claimed there; they still work from the app chrome.
    for (const platform of ['darwin', 'linux', 'win32']) {
      const primary = platform === 'darwin' ? { meta: true } : { control: true }
      for (const key of ['k', 'n', '1', '2', '3', '4', ',']) {
        expect(hasChord(platform, { key, ...primary })).toBe(false)
      }
    }
  })
})

describe('browserSwitcherChords', () => {
  it('still resolves the Ctrl+Tab switcher, which a browser reserves', () => {
    setPlatform('darwin')
    const chords = browserSwitcherChords(source)
    expect(chords.some((chord) => chord.key === 'tab' && chord.control)).toBe(true)
  })
})
