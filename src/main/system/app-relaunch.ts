import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isShippedBuild } from '../bootstrap/app-resources'
import { buildProcessEnvironment, resolveExecutablePath } from '../drivers/cli-environment'

/** Development owns a renderer server as well as Electron; restart both. */
export function queueAppRelaunch(): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isShippedBuild() || process.env['NODE_ENV'] === 'production' || !rendererUrl) {
    app.relaunch()
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
