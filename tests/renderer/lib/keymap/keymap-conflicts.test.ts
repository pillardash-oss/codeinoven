import { describe, expect, it } from 'vitest'
import { KEYMAP, keymapKeys, keymapShortcuts } from '$lib/keymap/keymap'
import {
  KEYMAP_CONTEXTS,
  keymapContextLabel,
  keymapContextsOverlap,
  type KeymapContextId
} from '$lib/keymap/keymap-contexts'
import { findKeymapBindingConflicts, type KeymapOverrideTokens } from '$lib/keymap/keymap-conflicts'

const entries = keymapShortcuts()

function contextOf(id: string): KeymapContextId {
  const shortcut = entries.find((entry) => entry.id === id)
  if (!shortcut) throw new Error(`Unknown keymap id: ${id}`)
  return shortcut.context
}

function overrides(values: Record<string, readonly string[]>): KeymapOverrideTokens {
  return values
}

describe('keymap registry contexts', () => {
  it('gives every shortcut a known context', () => {
    for (const category of KEYMAP.categories) {
      for (const shortcut of category.shortcuts) {
        expect(
          KEYMAP_CONTEXTS[shortcut.context],
          `${shortcut.id} → ${shortcut.context}`
        ).toBeDefined()
      }
    }
  })

  it('keeps every overlap target a real context', () => {
    for (const [id, context] of Object.entries(KEYMAP_CONTEXTS)) {
      if (context.overlaps === 'all') continue
      for (const target of context.overlaps) {
        expect(target, `${id} overlaps ${target}`).not.toBe('')
        expect(KEYMAP_CONTEXTS[target], `${id} overlaps ${target}`).toBeDefined()
      }
    }
  })

  it('reads overlaps both ways and keeps an overlay from meeting what it covers', () => {
    // Declared one way only in the table: the browser chrome lists the canvas.
    expect(keymapContextsOverlap('browser', 'browser-canvas')).toBe(true)
    expect(keymapContextsOverlap('composer-overlay', 'composer')).toBe(true)
    // A global handler is listening over every surface.
    expect(keymapContextsOverlap('global', 'video-editor')).toBe(true)
    expect(keymapContextsOverlap('system', 'settings')).toBe(true)
    // An overlay owns the keyboard while it is up, so what it covers is not
    // listening at the same moment.
    expect(keymapContextsOverlap('modal', 'file-tree')).toBe(false)
    expect(keymapContextsOverlap('palette', 'terminal')).toBe(false)
    // Two surfaces that are never focused together stay apart.
    expect(keymapContextsOverlap('settings', 'video-editor')).toBe(false)
    // A context always overlaps itself.
    expect(keymapContextsOverlap('git', 'git')).toBe(true)
  })

  it('names a surface for the conflict explanation', () => {
    expect(keymapContextLabel('composer')).toBe('The chat composer')
  })
})

describe('findKeymapBindingConflicts', () => {
  it('reports a chord already used where both handlers listen', () => {
    const target = entries.find((entry) => entry.id === 'nav-find')
    expect(target?.context).toBe('global')
    const report = findKeymapBindingConflicts('nav-find', ['mod', 'f'], overrides({}))
    const conflictIds = report.conflicts.map((conflict) => conflict.id)
    // `mod+f` is also find in the browser and in a conversation, and both can be
    // listening under the global find handler.
    expect(conflictIds).toContain('thread-find')
    expect(conflictIds).toContain('browser-find')
    expect(conflictIds).not.toContain('nav-find')
  })

  it('does not call the same chord in mutually exclusive surfaces a conflict', () => {
    // Escape closes the settings view, a find bar and a studio, and only one of
    // them is on screen at a time.
    const report = findKeymapBindingConflicts('nav-settings-back', ['escape'], overrides({}))
    expect(report.conflicts).toHaveLength(0)
    // The same chord under a surface that is never up with settings is still
    // worth mentioning.
    expect(report.sharedWith.map((entry) => entry.id)).toContain('files-find-close')
  })

  it('judges overrides where the user put them, not where the registry did', () => {
    // `files-find-next` ships on Enter and is moved onto the find chord, where a
    // conversation's find handler would answer the same press.
    const moved = overrides({ 'files-find-next': ['mod', 'f'] })
    const report = findKeymapBindingConflicts('thread-find', ['mod', 'f'], moved)
    expect(report.conflicts.map((conflict) => conflict.id)).toContain('files-find-next')

    // The chord an entry moved away from is free again.
    const elsewhere = overrides({ 'thread-find': ['mod', 'shift', 'f'] })
    const freed = findKeymapBindingConflicts('nav-settings', ['mod', 'f'], elsewhere)
    expect(freed.conflicts.map((conflict) => conflict.id)).not.toContain('thread-find')
  })

  it('checks both platforms, so a binding free here can still collide elsewhere', () => {
    // `nav-history-back` is mod+[ on macOS and alt+Left on other platforms.
    const report = findKeymapBindingConflicts('nav-settings', ['alt', 'arrowleft'], overrides({}))
    expect(report.conflicts.map((conflict) => conflict.id)).toContain('nav-history-back')
  })

  it('treats a repeated chord and a single press as the same first press', () => {
    // `chat-stop` is a double Escape in the composer, and the composer's own
    // Escape handlers close a menu on the first press.
    const report = findKeymapBindingConflicts('chat-send', ['escape'], overrides({}))
    expect(report.conflicts.map((conflict) => conflict.id)).toContain('chat-mention-close')
  })

  it('matches the double modifier gesture only with itself', () => {
    const report = findKeymapBindingConflicts('chat-focus-composer', ['double-mod'], overrides({}))
    expect(report.conflicts).toHaveLength(0)
    expect(report.sharedWith).toHaveLength(0)
  })

  it('reports nothing for a descriptive binding that cannot be compared', () => {
    const report = findKeymapBindingConflicts('nav-settings', [], overrides({}))
    expect(report).toEqual({ conflicts: [], sharedWith: [] })
  })

  it('carries the other binding so the dialog can show what is being overwritten', () => {
    const report = findKeymapBindingConflicts('nav-find', ['mod', 'f'], overrides({}))
    const threadFind = report.conflicts.find((conflict) => conflict.id === 'thread-find')
    expect(threadFind?.keys).toEqual(keymapKeys('thread-find'))
    expect(threadFind?.scenario.length).toBeGreaterThan(0)
  })

  it('reads the context of the entry being rebound', () => {
    expect(contextOf('chat-send')).toBe('composer')
  })
})
