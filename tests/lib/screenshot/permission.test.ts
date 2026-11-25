import { describe, expect, it } from 'vitest'
import {
  screenshotPermissionAllowsCapture,
  screenshotPermissionGuidance,
  type ScreenshotPermissionState
} from '../../../src/lib/screenshot/permission'

/** The pane's own label, which changes name in macOS 27. */
const PANE = 'Screen & System Audio Recording'

describe('screenshot permission guidance', () => {
  it('treats a granted or ungated machine as ready without a word', () => {
    for (const state of ['granted', 'not-required'] as const) {
      expect(screenshotPermissionAllowsCapture(state)).toBe(true)
      const guidance = screenshotPermissionGuidance(state, PANE)
      expect(guidance.promptable).toBe(false)
      expect(guidance.settingsRequired).toBe(false)
      expect(guidance.message).toBe('')
    }
  })

  it('asks macOS for its own prompt only before it has answered', () => {
    for (const state of ['not-determined', 'unknown'] as const) {
      const guidance = screenshotPermissionGuidance(state, PANE)
      expect(guidance.promptable).toBe(true)
      // Nothing has been refused yet, so the app may not drag the person into
      // System Settings before the system had its say.
      expect(guidance.settingsRequired).toBe(false)
      expect(guidance.message).toContain(PANE)
    }
  })

  it('sends a refusal to the pane, because no call can prompt again', () => {
    for (const state of ['denied', 'restricted'] as const) {
      const guidance = screenshotPermissionGuidance(state, PANE)
      expect(guidance.promptable).toBe(false)
      expect(guidance.settingsRequired).toBe(true)
      expect(guidance.message).toContain(PANE)
      // The stale-grant case: the switch reads on while the build cannot use it,
      // so the message has to tell the person to rebuild the row.
      expect(guidance.message).toContain('remove CodeInOven')
    }
  })

  it('reads every state the platform can report as either ready or repairable', () => {
    const states: ScreenshotPermissionState[] = [
      'granted',
      'denied',
      'restricted',
      'not-determined',
      'unknown',
      'not-required'
    ]
    for (const state of states) {
      const guidance = screenshotPermissionGuidance(state, PANE)
      const ready = screenshotPermissionAllowsCapture(state)
      // A state either allows a capture or explains what stands in the way.
      expect(ready || guidance.message.length > 0).toBe(true)
    }
  })
})
