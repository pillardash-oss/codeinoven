import { describe, expect, it } from 'vitest'
import { keymapKeys, keymapShortcut } from '$lib/keymap/keymap'
import { withBindingOverride, withResetOverride } from '$lib/keymap/keymap-overrides'

describe('withBindingOverride', () => {
  it('stores a new chord as a token string', () => {
    expect(withBindingOverride('nav-find', ['mod', 'shift', 'f'], {})).toEqual({
      'nav-find': 'mod shift f'
    })
  })

  it('stores an empty binding as unbind, not as a missing entry', () => {
    // A missing entry means "registry default", which is the opposite of unbound
    // and is exactly the chord a confirmed conflict has to clear.
    expect(withBindingOverride('nav-find', [], { 'nav-find': 'mod f' })).toEqual({
      'nav-find': ''
    })
  })

  it('drops the entry when the user binds the registry default again', () => {
    const shortcut = keymapShortcut('nav-settings')
    expect(shortcut).toBeDefined()
    expect(withBindingOverride('nav-settings', keymapKeys('nav-settings'), {})).toEqual({})
  })

  it('leaves every other entry exactly as it was', () => {
    const overrides = { 'nav-find': 'mod shift f', 'chat-send': 'mod enter' }
    expect(withBindingOverride('nav-settings', ['mod', ','], overrides)).toEqual(overrides)
  })
})

describe('withResetOverride', () => {
  it('forgets one override and keeps the rest', () => {
    expect(withResetOverride('nav-find', { 'nav-find': 'mod shift f', 'chat-send': '' })).toEqual({
      'chat-send': ''
    })
  })

  it('is a no-op for an entry that was never overridden', () => {
    expect(withResetOverride('nav-find', {})).toEqual({})
  })
})
