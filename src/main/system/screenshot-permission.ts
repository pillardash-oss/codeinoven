import { desktopCapturer, shell, systemPreferences } from 'electron'
import {
  screenshotPermissionAllowsCapture,
  screenshotPermissionGuidance,
  type ScreenshotPermissionState
} from '../../lib/screenshot/permission'
import { Logger } from './logger'

/**
 * The macOS Screen Recording grant a region capture depends on.
 *
 * The system, not this app, owns the answer. Reading it is free and never
 * prompts, so it runs before every capture and is never cached: a person who
 * grants the permission while the app is open must see the next attempt behave
 * differently.
 *
 * When macOS has not answered yet, the prompt is raised by asking the desktop
 * for a source, because that is the only call Electron exposes for this grant
 * (`askForMediaAccess` covers the microphone and the camera only). When macOS
 * has already refused, no call prompts at all: only the pane in System Settings
 * can change it, so the app opens that pane instead of leaving the person to
 * find it.
 */

/** The pane macOS 12 and later expose through this identifier. */
const MAC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture'

/** A prompt a person never notices must not hold a capture attempt forever. */
const PROMPT_TIMEOUT_MS = 30_000

/** What the operating system calls this grant in System Settings. */
function macPaneName(): string {
  const major = Number.parseInt(process.getSystemVersion().split('.')[0] ?? '0', 10)
  return Number.isFinite(major) && major >= 27
    ? 'Screen & System Audio Recording'
    : 'Screen Recording'
}

/** The platform's own answer, or `not-required` off macOS. */
export function screenshotPermissionState(): ScreenshotPermissionState {
  // Electron gates the screen behind TCC on macOS only; every other platform
  // captures without asking, so there is nothing to read or repair there.
  if (process.platform !== 'darwin') return 'not-required'
  try {
    const status = systemPreferences.getMediaAccessStatus('screen')
    if (
      status === 'granted' ||
      status === 'denied' ||
      status === 'restricted' ||
      status === 'not-determined'
    ) {
      return status
    }
    return 'unknown'
  } catch (error) {
    Logger.error('The screen recording access status could not be read:', error)
    return 'unknown'
  }
}

/**
 * Raise the system's own Screen Recording prompt, then read the answer again.
 *
 * The enumeration itself is the request: macOS shows its sheet the first time a
 * process asks for a source and remembers the answer. A prompt that is ignored
 * is settled as the state it really left behind, never assumed to be a refusal.
 */
async function raiseScreenRecordingPrompt(): Promise<ScreenshotPermissionState> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const enumeration = desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    })
    const timeout = new Promise<null>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(null), PROMPT_TIMEOUT_MS)
    })
    const sources = await Promise.race([enumeration, timeout])
    Logger.dev('The screen recording prompt was answered', {
      answered: sources !== null,
      sources: sources?.length ?? 0
    })
  } catch (error) {
    // A refused request throws instead of returning; the state read below is
    // the honest answer either way.
    Logger.dev('The screen recording prompt did not complete:', error)
  } finally {
    if (timer) clearTimeout(timer)
  }
  return screenshotPermissionState()
}

/** Open the exact System Settings pane that owns this grant. */
export async function openScreenshotPermissionSettings(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await shell.openExternal(MAC_SETTINGS_URL)
  } catch (error) {
    Logger.error('The screen recording settings pane could not be opened:', error)
  }
}

export interface ScreenshotPermissionOutcome {
  granted: boolean
  state: ScreenshotPermissionState
  /** What a person has to do, when the grant is not there yet. */
  message?: string
}

/**
 * Make sure the app may read the screen, asking the system the right way.
 *
 * Reads first: an existing grant costs one query. A state macOS has not decided
 * yet is answered by the system prompt. A refusal, or a prompt that left the
 * grant unmade, opens the pane the person has to use and reports the steps back
 * so the capture failure says more than "no".
 */
export async function ensureScreenshotPermission(): Promise<ScreenshotPermissionOutcome> {
  const before = screenshotPermissionState()
  if (screenshotPermissionAllowsCapture(before)) return { granted: true, state: before }

  const guidance = screenshotPermissionGuidance(before, macPaneName())
  if (!guidance.promptable) {
    await openScreenshotPermissionSettings()
    return { granted: false, state: before, message: guidance.message }
  }

  Logger.dev('Asking macOS for screen recording access', { state: before })
  const after = await raiseScreenRecordingPrompt()
  if (screenshotPermissionAllowsCapture(after)) return { granted: true, state: after }

  const settled = screenshotPermissionGuidance(after, macPaneName())
  if (settled.settingsRequired) await openScreenshotPermissionSettings()
  return { granted: false, state: after, message: settled.message }
}
