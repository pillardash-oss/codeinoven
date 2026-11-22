// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MODIFIER_TAP_WINDOW_MS,
  capturedKeyTokens,
  eventModifierToken,
  modifierTapTokens
} from '$lib/keymap/keymap-capture'

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('capturedKeyTokens', () => {
  it('maps the primary modifier to mod on macOS', () => {
    expect(capturedKeyTokens(press({ key: 'n', metaKey: true }), true)).toEqual(['mod', 'n'])
  })

  it('maps Control to mod off macOS, and Command to cmd', () => {
    expect(capturedKeyTokens(press({ key: 'n', ctrlKey: true }), false)).toEqual(['mod', 'n'])
    expect(capturedKeyTokens(press({ key: 'n', metaKey: true }), false)).toEqual(['cmd', 'n'])
  })

  it('keeps Control as its own modifier on macOS', () => {
    expect(capturedKeyTokens(press({ key: 'Tab', ctrlKey: true, shiftKey: true }), true)).toEqual([
      'ctrl',
      'shift',
      'tab'
    ])
  })

  it('orders modifiers before the key and names the special ones', () => {
    expect(
      capturedKeyTokens(press({ key: 'Enter', metaKey: true, altKey: true, shiftKey: true }), true)
    ).toEqual(['mod', 'alt', 'shift', 'enter'])
    expect(capturedKeyTokens(press({ key: ' ' }), true)).toEqual(['space'])
    expect(capturedKeyTokens(press({ key: 'ArrowUp' }), true)).toEqual(['arrowup'])
    expect(capturedKeyTokens(press({ key: 'Escape', shiftKey: true }), true)).toEqual([
      'shift',
      'escape'
    ])
  })

  it('lowercases a shifted letter so shift stays the description', () => {
    expect(capturedKeyTokens(press({ key: 'N', shiftKey: true }), true)).toEqual(['shift', 'n'])
  })

  it('returns null for a bare modifier, which binds nothing on its own', () => {
    expect(capturedKeyTokens(press({ key: 'Meta', metaKey: true }), true)).toBeNull()
    expect(capturedKeyTokens(press({ key: 'Shift', shiftKey: true }), true)).toBeNull()
  })
})

describe('eventModifierToken', () => {
  it('names the platform primary modifier as mod', () => {
    expect(eventModifierToken(press({ key: 'Meta' }), true)).toBe('mod')
    expect(eventModifierToken(press({ key: 'Control' }), false)).toBe('mod')
    expect(eventModifierToken(press({ key: 'Control' }), true)).toBe('ctrl')
    expect(eventModifierToken(press({ key: 'Meta' }), false)).toBe('cmd')
    expect(eventModifierToken(press({ key: 'Alt' }), true)).toBe('alt')
    expect(eventModifierToken(press({ key: 'a' }), true)).toBeNull()
  })
})

describe('modifierTapTokens', () => {
  it('binds nothing for one tap', () => {
    expect(modifierTapTokens('alt', 1)).toBeNull()
  })

  it('turns two taps of the primary modifier into the double modifier gesture', () => {
    expect(modifierTapTokens('mod', 2)).toEqual(['double-mod'])
  })

  it('repeats a secondary modifier as the registry does for dictation', () => {
    expect(modifierTapTokens('alt', 2)).toEqual(['alt', 'alt'])
    expect(modifierTapTokens('alt', 3)).toEqual(['alt', 'alt', 'alt'])
  })

  it('gives the capture control a window to count the taps in', () => {
    expect(MODIFIER_TAP_WINDOW_MS).toBeGreaterThan(0)
  })
})
