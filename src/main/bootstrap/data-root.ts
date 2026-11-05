import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { getConfigRoot, isUnpackagedElectronLaunch } from '../../lib/utils'
import { isShippedBuild } from './app-resources'
import { Logger } from '../system/logger'
import {
  instanceSlotPidFile,
  instanceSlotProfileDirectory,
  requestedInstanceSlot
} from '../system/instance-slots'

/**
 * Keep every Chromium-owned file inside CodeInOven's own data root.
 *
 * Electron otherwise derives `userData` from the product name and writes a whole
 * profile beside the app: `~/Library/Application Support/CodeInOven` on macOS,
 * `~/.config/CodeInOven` on Linux. That profile is not junk. It holds the
 * renderer's own cookies and local storage, the app's `owned-processes.json`
 * journal, and `Partitions/`, one Chromium profile per browser context, which is
 * where the user's real browsing state lives and where a project's cache can reach
 * gigabytes. Keeping it in the one directory the app owns is what makes "delete the
 * data root" mean something, and it is what stops a probe started with its own data
 * root from browsing inside the user's profile.
 *
 * This path is selected before `ready`. Existing profile directories stay where
 * they are; startup never relocates or merges Chromium data. Only the Chromium
 * profile is split: a packaged launch uses `<config-root>/electron` and an
 * unpackaged development launch uses `<config-root>/dev-browser-profile`, so the
 * two Electron instances never lock or corrupt each other's cookies. Every other
 * app data (database, projects, threads) keeps sharing the same config root.
 *
 */
export function configureElectronDataRoot(): void {
  // An extra instance opened from a running app occupies its own reusable slot
  // profile. The single-instance lock is keyed by this path, so without a path
  // of its own the second launch would hand its arguments to the first and
  // exit. Only the Chromium profile moves: the config root, and with it the
  // database, projects and threads, stays shared, which is what makes the new
  // process a secondary window into the same data rather than a second app.
  const slot = requestedInstanceSlot()
  if (slot !== null) {
    const slotRoot = instanceSlotProfileDirectory(slot)
    try {
      mkdirSync(slotRoot, { recursive: true })
      app.setPath('userData', slotRoot)
      app.setPath('sessionData', slotRoot)
      // Record which process holds the slot so the launcher only reuses it once
      // this one is gone.
      writeFileSync(instanceSlotPidFile(slot), String(process.pid), 'utf8')
    } catch (error: unknown) {
      Logger.error('Extra instance profile could not be configured:', error)
    }
    return
  }

  // Windows production already uses Electron's established `%APPDATA%` location.
  // Keep it in place while unpackaged development still receives its own profile.
  if (process.platform === 'win32' && isShippedBuild()) return
  const profileDir = isUnpackagedElectronLaunch() ? 'dev-browser-profile' : 'electron'
  const managedRoot = join(getConfigRoot(), profileDir)
  try {
    mkdirSync(managedRoot, { recursive: true })
    app.setPath('userData', managedRoot)
    app.setPath('sessionData', managedRoot)
  } catch (error: unknown) {
    // A profile that cannot be redirected must never stop the app from starting.
    Logger.error('Electron data root could not be configured:', error)
  }
}

/**
 * Report an explicit `CODEINOVEN_CONFIG_ROOT` redirect once per launch, so a
 * developer running several worktrees side by side can always tell which
 * app-owned data root this instance actually opened, and why an ignored value
 * (relative path, or a shipped app) was ignored instead of silently falling
 * back to the real one.
 */
export function logConfiguredDataRoot(): void {
  const configuredRoot = process.env['CODEINOVEN_CONFIG_ROOT']
  if (!configuredRoot) return
  if (isAbsolute(configuredRoot) && getConfigRoot() === configuredRoot) {
    Logger.info('Config root redirected by CODEINOVEN_CONFIG_ROOT', { configuredRoot })
    return
  }
  Logger.info('CODEINOVEN_CONFIG_ROOT ignored', {
    configuredRoot,
    reason:
      'an absolute path is required, and only an unpackaged launch or the packaged smoke harness may redirect the data root'
  })
}
