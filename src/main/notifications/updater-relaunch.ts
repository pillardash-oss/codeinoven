import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'

/**
 * A relaunch asked for from the menu bar must come back windowless.
 *
 * An update installed while the app was running in the menu bar is not a reason
 * to take over the user's screen when it restarts: they asked for a background
 * app, and the restart is an implementation detail. The updater leaves this
 * marker behind only when no window was open at install time; the next startup
 * consumes it and boots headless, exactly like a login launch in background
 * mode.
 *
 * A plain file rather than stored state on purpose: the startup check runs
 * before the storage engine is initialized, so it must not depend on it.
 */
const MARKER_PATH = 'updater/relaunch-in-background'

function markerPath(): string {
  return join(getConfigRoot(), MARKER_PATH)
}

/** Leave the marker for the next launch. */
export function markBackgroundRelaunch(): void {
  try {
    const path = markerPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(Date.now()), 'utf8')
  } catch (error) {
    Logger.error('Could not write the background relaunch marker', error)
  }
}

/** Read and clear the marker. True when this launch should start windowless. */
export function consumeBackgroundRelaunchMarker(): boolean {
  const path = markerPath()
  try {
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  } catch (error) {
    Logger.error('Could not read the background relaunch marker', error)
    return false
  }
}
