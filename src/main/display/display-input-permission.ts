import { shell, systemPreferences } from 'electron'
import type { DisplayInputPermission } from '../../lib/ipc/display'

/**
 * Whether this machine lets the app post input into another application's window.
 *
 * A simulator is an ordinary window on the desktop, so controlling it means
 * posting real clicks, drags and keystrokes at it. Every desktop OS keeps that
 * behind a grant, and each one phrases it differently:
 *
 * - macOS hides it in Privacy & Security under `Accessibility`, and the app may
 *   raise the system's own prompt for it.
 * - Windows and Linux do not gate synthetic input at all, so the honest answer
 *   there is "granted" before anything is asked.
 *
 * The check runs when a simulator is targeted, not at boot: a person who never
 * mirrors a device should never meet a permission dialog for it, and a person who
 * has already granted it should never see the walkthrough at all. Nothing is
 * cached between calls, because granting while the panel is open has to be
 * visible without a restart.
 */

/** The pane macOS 27 files this grant under, by the identifier its URL takes. */
const MAC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?privacy-accessibility'

/**
 * What macOS 27 calls this grant in System Settings.
 *
 * The pane used to be "Accessibility". Newer releases split the grants apart and
 * renamed this one "Device Control and Data Access", which is where a person will
 * find the switch for the app. A walkthrough that names the wrong pane is worse
 * than none, so the label follows the release the app is running on.
 */
function macPaneName(): string {
  const major = Number.parseInt(process.getSystemVersion().split('.')[0] ?? '0', 10)
  return Number.isFinite(major) && major >= 27 ? 'Device Control and Data Access' : 'Accessibility'
}

/**
 * What the person has to do on macOS, in the order the settings window shows it.
 *
 * The pane's own label is used in the step, because the app cannot move the switch
 * itself: the grant is the operating system's to give, and the walkthrough's only
 * job is to point at the exact row.
 */
function macSteps(pane: string): string[] {
  return [
    'Open System Settings and go to Privacy & Security',
    `Open ${pane}`,
    'Turn on CodeInOven, adding it with + if it is not listed',
    'Come back to this panel and press Check again'
  ]
}

function platformName(): DisplayInputPermission['platform'] {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'linux') return 'linux'
  return 'other'
}

function grantedNow(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

function describe(granted: boolean): DisplayInputPermission {
  const platform = platformName()
  if (platform !== 'darwin') {
    return { granted: true, platform, canPrompt: false, steps: [] }
  }
  if (granted) return { granted: true, platform, canPrompt: true, steps: [] }
  const pane = macPaneName()
  return {
    granted: false,
    platform,
    canPrompt: true,
    steps: macSteps(pane),
    settingsName: pane,
    settingsUrl: MAC_SETTINGS_URL
  }
}

/** Read the current grant. Never prompts. */
export function readInputPermission(): DisplayInputPermission {
  return describe(grantedNow())
}

/**
 * Raise the system prompt for the grant, then report the answer.
 *
 * On macOS this is the sheet macOS itself owns, which is the only honest way to
 * ask: it names the app, explains the grant, and offers the button that opens the
 * pane. The answer is read again afterwards rather than trusting the call, since
 * the person may open the settings window and come back later.
 */
export function requestInputPermission(): DisplayInputPermission {
  if (process.platform === 'darwin') {
    try {
      systemPreferences.isTrustedAccessibilityClient(true)
    } catch {
      // A platform build without the prompt still reports its real state below.
    }
  }
  return describe(grantedNow())
}

/** Open the pane that owns this grant, if the platform has one. */
export async function openInputPermissionSettings(): Promise<void> {
  const permission = describe(false)
  if (!permission.settingsUrl) return
  await shell.openExternal(permission.settingsUrl)
}
