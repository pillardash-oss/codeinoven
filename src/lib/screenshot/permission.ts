/**
 * What the operating system says about this app's Screen Recording grant, and
 * what a person can do about it.
 *
 * A region capture is only possible with that grant, and macOS answers it in one
 * of three ways: it is on, it has never been asked, or it was refused. The third
 * answer is the one that needs a person in System Settings, because the app may
 * not move that switch itself.
 *
 * The guidance is pure so every state gets the same wording wherever it is shown
 * (the capture failure, the settings surface), and main only has to supply the
 * operating system's own name for the pane.
 */

/** Every answer `systemPreferences.getMediaAccessStatus('screen')` can give. */
export type ScreenshotPermissionState =
  'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' | 'not-required'

export interface ScreenshotPermissionGuidance {
  /** True only for a state that macOS still shows its own prompt for. */
  promptable: boolean
  /** Where a person has to go, when the app cannot raise the prompt itself. */
  settingsRequired: boolean
  /** One sentence naming what is wrong, phrased for a toast. */
  message: string
}

/**
 * The pane's guidance for one permission state.
 *
 * `paneName` is the operating system's own label ("Screen Recording" before
 * macOS 27, "Screen & System Audio Recording" after it), so the instruction
 * names a row the person can actually find instead of a name this app invented.
 */
export function screenshotPermissionGuidance(
  state: ScreenshotPermissionState,
  paneName: string
): ScreenshotPermissionGuidance {
  if (state === 'granted' || state === 'not-required') {
    return { promptable: false, settingsRequired: false, message: '' }
  }
  if (state === 'not-determined' || state === 'unknown') {
    return {
      promptable: true,
      settingsRequired: false,
      message: `macOS has not answered the Screen Recording request for this app yet. Allow it in the system prompt, then relaunch the app before taking the screenshot again. If no prompt appears, turn it on in System Settings › Privacy & Security › ${paneName}.`
    }
  }
  return {
    promptable: false,
    settingsRequired: true,
    // A grant made by an earlier build keeps the code identity it was made
    // with, and a build signed under a different identity can never match it.
    // That is why the switch can look on while the capture still fails, and why
    // the row has to be rebuilt instead of trusted.
    message: `Screen Recording is off for this app. System Settings is open on the ${paneName} pane: turn on CodeInOven, then quit and reopen the app before taking the screenshot again. If it is already on, remove CodeInOven from the list with − and add it back with +, because that rebuilds the permission for this build.`
  }
}

/** Whether the app may capture a region right now. */
export function screenshotPermissionAllowsCapture(state: ScreenshotPermissionState): boolean {
  return state === 'granted' || state === 'not-required'
}
