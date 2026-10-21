import { describe, expect, it } from 'vitest'
import { NATIVE_TOOLTIP_DOCK_ID, nativeDockProjectedOnPlatform } from '../../src/lib/native-dock'

describe('native dock projection policy', () => {
  it('keeps only the tooltip out of a native host on Linux', () => {
    expect(nativeDockProjectedOnPlatform(NATIVE_TOOLTIP_DOCK_ID, 'linux')).toBe(false)
    expect(nativeDockProjectedOnPlatform(NATIVE_TOOLTIP_DOCK_ID, 'darwin')).toBe(true)
    expect(nativeDockProjectedOnPlatform(NATIVE_TOOLTIP_DOCK_ID, 'win32')).toBe(true)
  })

  it('projects every other dock on every platform, Linux included', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      expect(nativeDockProjectedOnPlatform('thread-switcher', platform)).toBe(true)
      expect(nativeDockProjectedOnPlatform('browser-tab-strip', platform)).toBe(true)
      expect(nativeDockProjectedOnPlatform('dock-test', platform)).toBe(true)
    }
  })

  it('treats an unknown platform as one that projects', () => {
    expect(nativeDockProjectedOnPlatform(NATIVE_TOOLTIP_DOCK_ID, '')).toBe(true)
  })
})
