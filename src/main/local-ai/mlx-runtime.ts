/**
 * Detect and probe the `mlx_lm.server` the Local AI page launches.
 *
 * MLX is not bundled: it is a Python package Homebrew installs as `mlx-lm`, which
 * puts `mlx_lm.server` on PATH. Detection resolves that binary the way a shell
 * would (PATH, plus the Homebrew prefixes a GUI app does not inherit), reads the
 * version from the keg it lives in, and reports which package manager can install
 * or update it here. Starting it is the page's job; nothing long-running runs here.
 */
import { realpath } from 'node:fs/promises'
import { localAiBrewFormula, type LocalAiRuntimeStatus } from '../../lib/llama-cpp'
import { findExecutable, findHomebrew, readAvailableUpdate } from './local-ai-binary'

/**
 * Homebrew installs the package under `Cellar/mlx-lm/<version>/`, which is the
 * only place the version is written down: the server has no `--version`, and
 * running a Python interpreter to import the package would cost a process spawn on
 * a settings page. The PATH entry is a symlink into that keg, so the link is
 * resolved first.
 */
async function readVersion(path: string): Promise<string> {
  const candidates = [await resolvedPath(path), path]
  for (const candidate of candidates) {
    const match = /(?:Cellar|opt)\/mlx-lm\/([^/]+)\//u.exec(candidate)
    if (match?.[1]) return match[1]
  }
  return ''
}

async function resolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return ''
  }
}

function runtimeDetail(path: string, installer: 'homebrew' | null): string {
  if (path) {
    return installer === 'homebrew'
      ? 'Installed through Homebrew. Update to take a newer mlx-lm build.'
      : 'Found on this machine. The app will launch this server.'
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return 'MLX needs an Apple Silicon Mac.'
  }
  if (installer === 'homebrew') {
    return 'mlx_lm.server is not installed yet. Homebrew can install it for you.'
  }
  return 'mlx_lm.server is not installed, and Homebrew was not found. Install Homebrew first, then install mlx-lm.'
}

export async function detectMlxRuntime(): Promise<LocalAiRuntimeStatus> {
  const [path, brew] = await Promise.all([findExecutable('mlx_lm.server'), findHomebrew()])
  const installer: 'homebrew' | null = brew ? 'homebrew' : null
  const [version, update] = await Promise.all([
    path ? readVersion(path) : Promise.resolve(''),
    readAvailableUpdate(brew, localAiBrewFormula('mlx'))
  ])
  return {
    runtime: 'mlx',
    platform: process.platform,
    installed: path.length > 0,
    path,
    version: path ? version : '',
    installer,
    installerPath: brew,
    updateAvailable: update.updateAvailable,
    latestVersion: update.latestVersion,
    detail: runtimeDetail(path, installer)
  }
}
