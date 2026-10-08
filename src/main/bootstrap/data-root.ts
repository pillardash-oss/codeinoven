import { app } from 'electron'
import { mkdirSync } from 'fs'
import { isAbsolute, join } from 'path'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'

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
 * they are; startup never relocates or merges Chromium data. Development gets a
 * separate checkout-local config root from `getConfigRoot`.
 *
 */
export function configureElectronDataRoot(): void {
  // Windows production already uses Electron's established `%APPDATA%` location.
  // Keep it in place while unpackaged development still receives its own root.
  if (process.platform === 'win32' && app.isPackaged) return
  const managedRoot = join(getConfigRoot(), 'electron')
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
