import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isShippedBuild } from '../bootstrap/app-resources'
import { buildProcessEnvironment, resolveExecutablePath } from '../drivers/cli-environment'
import { APP_NAME, APP_SLUG } from '../../lib/brand'

/**
 * The executable a packaged relaunch has to start.
 *
 * Windows and Linux launch the app through the tiny native supervisor, so
 * relaunching the Electron runtime alone would skip the splash and leave the
 * next launch unsupervised. macOS runs the app as the bundle's own main
 * executable, so its current path is already the right target.
 */
function packagedRelaunchTarget(): string | null {
  if (process.platform === 'darwin') return null
  const publicName = process.platform === 'win32' ? `${APP_NAME}.exe` : APP_SLUG
  const candidate = join(dirname(process.execPath), publicName)
  return existsSync(candidate) ? candidate : null
}

/** Development owns a renderer server as well as Electron; restart both. */
export function queueAppRelaunch(): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isShippedBuild() || process.env['NODE_ENV'] === 'production' || !rendererUrl) {
    const supervisor = packagedRelaunchTarget()
    app.relaunch(supervisor === null ? undefined : { execPath: supervisor })
    return
  }

  const root = app.getAppPath()
  const runner = join(root, 'scripts', 'restart-development.ts')
  const bun = resolveExecutablePath(
    'bun',
    buildProcessEnvironment(process.env, process.platform, false)
  )
  if (!bun || !existsSync(runner)) {
    throw new Error('The development restart runner or Bun executable is unavailable')
  }
  // Electron's relaunch helper survives even a forced exit. Its replacement
  // waits for electron-vite to release the renderer port before starting Vite.
  app.relaunch({ execPath: bun, args: [runner, rendererUrl] })
}
