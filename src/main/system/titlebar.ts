import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  NO_TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_ARG_PREFIX,
  TRAFFIC_LIGHT_OFFSET,
  serializeTrafficLight,
  type TrafficLightInfo
} from '../../lib/traffic-light'

interface DecorationLayout {
  left: boolean
  right: boolean
}

/** Split a GTK decoration/button layout (`left,right:minimize,maximize,close`). */
function parseLayout(value: string): DecorationLayout {
  const [left = '', right = ''] = value.split(':')
  const hasControls = (part: string): boolean =>
    part
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean).length > 0
  return { left: hasControls(left), right: hasControls(right) }
}

/** Read `gtk-decoration-layout` from the user's GTK settings, newest first. */
async function readGtkSettingsFile(): Promise<DecorationLayout | null> {
  for (const settingsFile of ['.config/gtk-4.0/settings.ini', '.config/gtk-3.0/settings.ini']) {
    try {
      const text = await readFile(join(homedir(), settingsFile), 'utf8')
      const match = /^\s*gtk-decoration-layout\s*=\s*(.+?)\s*$/m.exec(text)
      if (match) return parseLayout(match[1])
    } catch {
      // Missing or unreadable file — try the next source.
    }
  }
  return null
}

/** Read the GNOME window-manager button layout via `gsettings`. */
function readGsettingsButtonLayout(): Promise<DecorationLayout | null> {
  return new Promise((resolve) => {
    execFile(
      'gsettings',
      ['get', 'org.gnome.desktop.wm.preferences', 'button-layout'],
      { timeout: 2000 },
      (error, stdout) => {
        if (error) return resolve(null)
        const value = stdout.trim().replace(/^'|'$/g, '')
        if (!value) return resolve(null)
        resolve(parseLayout(value))
      }
    )
  })
}

/**
 * Resolve where the window controls live for the current OS.
 *
 * macOS: traffic lights always sit inset on the left.
 * Windows: the native frame owns its own controls — nothing to reserve.
 * Linux: the side is user-configurable (GTK decoration layout / GNOME button
 * layout). When no layout can be read the safe default is no offset, so no
 * space is wasted on platforms that render no in-content controls.
 */
export async function resolveTrafficLightInfo(): Promise<TrafficLightInfo> {
  if (process.platform === 'darwin') {
    return { present: true, side: 'left', offset: TRAFFIC_LIGHT_OFFSET }
  }
  if (process.platform === 'win32') {
    return NO_TRAFFIC_LIGHT
  }
  if (process.platform === 'linux') {
    const layout = (await readGtkSettingsFile()) ?? (await readGsettingsButtonLayout())
    if (layout?.left) return { present: true, side: 'left', offset: TRAFFIC_LIGHT_OFFSET }
    if (layout?.right) return { present: true, side: 'right', offset: TRAFFIC_LIGHT_OFFSET }
  }
  return NO_TRAFFIC_LIGHT
}

let cachedArg: string | null = null

/** Synchronous fallback used before the async detection has completed. */
function syncDefaultArg(): string {
  const info: TrafficLightInfo =
    process.platform === 'darwin'
      ? { present: true, side: 'left', offset: TRAFFIC_LIGHT_OFFSET }
      : NO_TRAFFIC_LIGHT
  return serializeTrafficLight(info)
}

/** Resolve the layout once and cache the argv flag for every window. */
export async function warmTrafficLightDetection(): Promise<void> {
  cachedArg = serializeTrafficLight(await resolveTrafficLightInfo())
}

/** The `additionalArguments` payload to pass into each BrowserWindow. */
export function getTrafficLightArg(): string {
  const value = cachedArg ?? syncDefaultArg()
  return `${TRAFFIC_LIGHT_ARG_PREFIX}${value}`
}
