import { app } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'

/**
 * Electron otherwise derives Linux `userData` from the product name and creates
 * `~/.config/CodeInOven` alongside CodeInOven's canonical Pillardash config
 * root. Redirect Chromium before `ready` and move the legacy directory on the
 * first upgraded launch so cookies, local storage, caches, and the
 * owned-process journal are preserved instead of orphaned.
 */
export function configureLinuxElectronDataRoot(): void {
  if (process.platform !== 'linux') return

  const legacyRoot = app.getPath('userData')
  const managedRoot = join(getConfigRoot(), 'electron')
  mkdirSync(dirname(managedRoot), { recursive: true })

  if (legacyRoot !== managedRoot && existsSync(legacyRoot) && !existsSync(managedRoot)) {
    renameSync(legacyRoot, managedRoot)
  } else {
    mkdirSync(managedRoot, { recursive: true })
  }

  app.setPath('userData', managedRoot)
  app.setPath('sessionData', managedRoot)
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
