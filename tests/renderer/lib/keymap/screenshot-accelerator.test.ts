// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { keymapKeys } from '$lib/keymap/keymap'
import { acceleratorForKeys } from '$lib/keymap/screenshot-accelerator'

/** Pin the platform the way the Electron bridge does, so the accelerator is
 *  resolved for the machine the chord will actually be claimed on. */
function setPlatform(platform: string): void {
  Object.defineProperty(window, 'api', {
    value: { windowInfo: { platform } },
    configurable: true
  })
}

describe('region screenshot accelerator', () => {
  it('claims the registry default as a system-wide macOS chord', () => {
    setPlatform('darwin')
    expect(acceleratorForKeys(keymapKeys('screenshot-region'))).toBe('Command+Shift+7')
  })

  it('uses Control outside macOS', () => {
    setPlatform('win32')
    expect(acceleratorForKeys(['mod', 'shift', '7'])).toBe('Control+Shift+7')
  })

  it('names keys Electron spells differently', () => {
    setPlatform('darwin')
    expect(acceleratorForKeys(['mod', 'arrowleft'])).toBe('Command+Left')
    expect(acceleratorForKeys(['mod', ','])).toBe('Command+Comma')
    expect(acceleratorForKeys(['mod', 'f5'])).toBe('Command+F5')
  })

  it('refuses a binding that is not one global chord', () => {
    setPlatform('darwin')
    expect(acceleratorForKeys([])).toBeNull()
    expect(acceleratorForKeys(['escape', 'escape'])).toBeNull()
    expect(acceleratorForKeys(['alt', 'alt'])).toBeNull()
    expect(acceleratorForKeys(['mod', '[', 'alt', 'arrowleft'])).toBe('Command+[')
  })

  it('never claims a bare key from every other app', () => {
    setPlatform('darwin')
    expect(acceleratorForKeys(['7'])).toBeNull()
    expect(acceleratorForKeys(['space'])).toBeNull()
  })
})
