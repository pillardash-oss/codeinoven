/**
 * Ensure the Electron binary is downloaded in node_modules.
 *
 * Bun sometimes skips the `electron` package's own install script (e.g. when
 * node_modules is restored from a cache or installed with a different
 * lifecycle-script configuration), leaving `node_modules/electron/dist/` and
 * `path.txt` missing. `electron-vite` then crashes at startup with
 * "Error: Electron uninstall".
 *
 * This script exits instantly when the binary is present, and otherwise runs
 * the package's own `install.js` so the exact pinned Electron version is
 * fetched. Runs via the `predev` hook so every dev start is self-healing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Logger } from '../src/main/system/logger'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules/electron')
const pathTxt = join(electronDir, 'path.txt')

function isBinaryPresent(): boolean {
  if (!existsSync(pathTxt)) return false
  try {
    // path.txt is written by electron's install.js relative to dist/
    const binaryPath = readFileSync(pathTxt, 'utf8').trim()
    return binaryPath.length > 0 && existsSync(join(electronDir, 'dist', binaryPath))
  } catch {
    return false
  }
}

if (!isBinaryPresent()) {
  Logger.dev('[ensure-electron-binary] Electron binary missing — downloading pinned version…')
  execFileSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' })
  Logger.dev('[ensure-electron-binary] Electron binary restored.')
}
