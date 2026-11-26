// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  appShortcutChords,
  browserShortcutBindings,
  browserSwitcherChords
} from '$lib/keymap/browser-shortcuts'
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

  it('claims the new-tab chords a page cannot answer, every platform', () => {
    // A browser reserves both chords: Cmd/Ctrl+T opens a tab in a browser, and
    // Cmd/Ctrl+N is the new-thread chord everywhere else in the app. Claiming it
    // here is what makes a press inside a page or the browser chrome open a tab
    // instead of starting a thread, the way the browser's own chrome does.
    for (const platform of ['darwin', 'linux', 'win32']) {
      const primary = platform === 'darwin' ? { meta: true } : { control: true }
      for (const key of ['t', 'n']) {
        expect(hasChord(platform, { key, ...primary })).toBe(true)
      }
    }
  })

  it('never claims an app shortcut from a page', () => {
    // The spotlight, a view switch and the sidebar toggles are the app's own.
    // While a page holds the keyboard the page wins, so none of them is claimed
    // there; they still work from the app chrome. `mod+n` is deliberately absent:
    // it is the browser's new-tab chord (see above), so the browser keeps it.
    for (const platform of ['darwin', 'linux', 'win32']) {
      const primary = platform === 'darwin' ? { meta: true } : { control: true }
      for (const key of ['k', '1', '2', '3', '4', ',']) {
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

function appChords(platform: string): ReturnType<typeof appShortcutChords> {
  setPlatform(platform)
  return appShortcutChords(source)
}

function carriesAppChord(platform: string, wanted: { key: string; shift?: boolean }): boolean {
  const wantsMac = platform === 'darwin'
  return appChords(platform).some(
    (chord) =>
      chord.key === wanted.key &&
      (wantsMac ? chord.meta : chord.control) &&
      chord.shift === Boolean(wanted.shift)
  )
}

describe('appShortcutChords', () => {
  it('reports the app shortcuts a page did not handle, every platform', () => {
    // These are the chords a page can only leave to the app, because the app's own
    // handler is the one that opens the surface: with none of them in this table a
    // page would silently kill the spotlight and every view switch. `mod+n` is not
    // here: the browser claims it for a new tab, so it never travels back.
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const key of ['k', '1', '2', '3', '4', ',']) {
        expect(carriesAppChord(platform, { key })).toBe(true)
      }
    }
  })

  it('never carries a reserved browser chord, so a page cannot override chrome', () => {
    // Reload, address focus, tab close and both new-tab chords are the browser's,
    // claimed in `before-input-event` before a page ever sees them; carrying them
    // here would let a page that reported them unhandled re-run them from the
    // wrong side. The new-tab chords are the exception the app's own new-thread
    // binding gave up: inside a browser the browser means a new tab by them.
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const key of ['r', 'w', 'l', 't', 'n']) {
        expect(carriesAppChord(platform, { key })).toBe(false)
      }
    }
  })

  it('never carries an editor chord a caret owns', () => {
    // Undo, bold and italic are native page editing commands: they do not mark the
    // key as handled, so replaying them would steal the page's own undo and move
    // focus out of the field the user was typing in.
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const key of ['z', 'b', 'i']) {
        expect(carriesAppChord(platform, { key })).toBe(false)
      }
    }
  })

  it('never carries a chord a page may not run', () => {
    // Deleting the open thread and quitting are not safe to fire from a page the
    // user was reading, so neither chord is ever offered to a page.
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(carriesAppChord(platform, { key: 'd' })).toBe(false)
    }
  })

  it('carries no arrow chord and no bare-key chord', () => {
    // Arrow chords are the page's caret and scroll movement, and every app chord
    // needs a primary modifier; a plain key is the page's own typing.
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const chord of appChords(platform)) {
        expect(['arrowup', 'arrowdown', 'arrowleft', 'arrowright']).not.toContain(chord.key)
        expect(chord.meta || chord.control || chord.alt).toBe(true)
      }
    }
  })
})
