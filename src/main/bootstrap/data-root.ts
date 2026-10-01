import { app } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'path'
import { getCanonicalConfigRoot, getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'
import { instanceRegistry } from '../system/instance-registry'

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
 * The managed path is applied before `ready`, and the first launch that can do so
 * moves whatever the default path already held, so cookies, local storage, and the
 * journal survive the change instead of being orphaned. The move is skipped while
 * another instance is running with that profile open, and skipped entirely for a
 * redirected data root, where inheriting the user's profile would hand a scratch
 * root their browser logins.
 *
 * Windows stays on Electron's default. `%APPDATA%` is that platform's convention,
 * and this project has no verified migration for its locked files.
 */
export function configureElectronDataRoot(): void {
  if (process.platform === 'win32') return
  const managedRoot = join(getConfigRoot(), 'electron')
  const legacyRoot = app.getPath('userData')
  if (legacyRoot === managedRoot) return
  try {
    if (!prepareChromiumDataRoot(legacyRoot, managedRoot)) return
    app.setPath('userData', managedRoot)
    app.setPath('sessionData', managedRoot)
  } catch (error: unknown) {
    // A profile that could not be relocated must never stop the app from starting:
    // Chromium's default path still works, just outside the app data root.
    Logger.error('Electron data root could not be redirected:', error)
  }
}

/**
 * Prepare the managed Chromium directory, answering whether it may be used.
 *
 * False means this launch must stay on Electron's default path. That only happens
 * for the canonical data root while another instance holds the profile there, and
 * staying put is the point: creating the managed root first would start a second,
 * empty profile beside the running one and strand every cookie in the first.
 */
function prepareChromiumDataRoot(legacyRoot: string, managedRoot: string): boolean {
  // A redirected root (a probe, a second checkout, the packaged smoke harness) has
  // no legacy profile of its own to inherit, so it always gets its own directory.
  if (getConfigRoot() !== getCanonicalConfigRoot()) {
    mkdirSync(managedRoot, { recursive: true })
    return true
  }
  if (existsSync(managedRoot)) return true
  // Only this user's own profile is ever moved. A launch whose home directory is
  // not the one the profile was written under (a test harness, another account)
  // starts a fresh profile instead of relocating someone else's browsing state.
  const isOwnProfile = legacyRoot.startsWith(`${homedir()}${sep}`)
  if (isOwnProfile && existsSync(legacyRoot) && instanceRegistry.hasOtherLiveInstance()) {
    Logger.info('Chromium profile left where another instance is using it', {
      legacyRoot,
      reason: 'the move is retried the first time this data root runs alone'
    })
    return false
  }
  mkdirSync(dirname(managedRoot), { recursive: true })
  if (isOwnProfile && existsSync(legacyRoot)) {
    renameSync(legacyRoot, managedRoot)
    Logger.info('Moved the Chromium profile into the app data root', { legacyRoot, managedRoot })
  } else {
    mkdirSync(managedRoot, { recursive: true })
  }
  return true
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
