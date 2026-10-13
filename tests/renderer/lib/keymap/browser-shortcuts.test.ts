// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { appShortcutChords } from '$lib/keymap/browser-shortcuts'
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

function publishedChords(platform: string): ReturnType<typeof appShortcutChords> {
  setPlatform(platform)
  return appShortcutChords(source)
}

function hasChord(
  platform: string,
  wanted: { key: string; meta?: boolean; control?: boolean; alt?: boolean }
): boolean {
  return publishedChords(platform).some(
    (published) =>
      published.key === wanted.key &&
      published.meta === Boolean(wanted.meta) &&
      published.control === Boolean(wanted.control) &&
      published.alt === Boolean(wanted.alt)
  )
}

describe('appShortcutChords', () => {
  it('never hands an arrow chord back to the app, so the page keeps its own word and scroll movement', () => {
    // Option+Arrow hops a word on macOS and Ctrl+Arrow does the same on Windows
    // and Linux. The terminal's word-hop binding and the palette's back gesture
    // are the app's only arrow chords, and neither surface can hold the keyboard
    // while a native page does, so claiming one would only preventDefault the
    // document's own gesture and pull focus out of the page.
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(publishedChords(platform).filter((chord) => chord.key.startsWith('arrow'))).toEqual([])
    }
  })

  it('still hands app-global shortcuts back from inside a page on macOS', () => {
    expect(hasChord('darwin', { key: 'k', meta: true })).toBe(true)
    expect(hasChord('darwin', { key: 'n', meta: true })).toBe(true)
    expect(hasChord('darwin', { key: '[', meta: true })).toBe(true)
  })

  it('still hands app-global shortcuts back from inside a page on Windows and Linux', () => {
    expect(hasChord('win32', { key: 'k', control: true })).toBe(true)
    expect(hasChord('linux', { key: 'n', control: true })).toBe(true)
  })

  it('does not hand a bare key back, so the page keeps it', () => {
    expect(
      publishedChords('darwin').every((chord) => chord.meta || chord.control || chord.alt)
    ).toBe(true)
  })
})
