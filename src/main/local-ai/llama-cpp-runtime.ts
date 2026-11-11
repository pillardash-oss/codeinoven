/**
 * Detect the `llama-server` binary the Local AI page launches.
 *
 * Detection is read-only and short: it resolves the binary the way a shell would
 * (PATH, plus the Homebrew prefixes a GUI app does not inherit), reads its version
 * once, and reports which package manager could install or update it here.
 * Everything long-running (the install itself) is the user's to watch in the
 * embedded terminal, never an `exec` inside this service.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { localAiBrewFormula, type LocalAiRuntimeStatus } from '../../lib/llama-cpp'
import { findExecutable, findHomebrew, readAvailableUpdate } from '../local-ai/local-ai-binary'

const run = promisify(execFile)

/**
 * llama.cpp prints `version: 0.5.0 (build 11146, commit …)` plus a progress
 * line for older builds. Keep the human-readable version and its build number.
 */
function parseVersion(output: string): string {
  const versionMatch = /version:\s*([0-9][^\s(]*)(?:\s*\(build\s*(\d+))?/u.exec(output)
  if (versionMatch) {
    const [, version, build] = versionMatch
    return build ? `${version} (build ${build})` : version
  }
  const buildMatch = /build\s+(\d+)/u.exec(output)
  return buildMatch ? `build ${buildMatch[1]}` : ''
}

async function readVersion(path: string): Promise<string> {
  try {
    const { stdout, stderr } = await run(path, ['--version'], { timeout: 15_000 })
    return parseVersion(`${stdout}\n${stderr}`)
  } catch {
    // A build that refuses `--version` still runs; the card shows the path and
    // states the version is unknown instead of pretending the binary is broken.
    return ''
  }
}

export async function detectLlamaCppRuntime(): Promise<LocalAiRuntimeStatus> {
  const [path, brew] = await Promise.all([findExecutable('llama-server'), findHomebrew()])
  const installer: 'homebrew' | null = brew ? 'homebrew' : null
  const [version, update] = await Promise.all([
    path ? readVersion(path) : Promise.resolve(''),
    readAvailableUpdate(brew, localAiBrewFormula('llama.cpp'))
  ])
  return {
    runtime: 'llama.cpp',
    platform: process.platform,
    installed: path.length > 0,
    path,
    version,
    installer,
    installerPath: brew,
    updateAvailable: update.updateAvailable,
    latestVersion: update.latestVersion,
    detail: runtimeDetail(process.platform, path, installer)
  }
}

function runtimeDetail(
  platform: NodeJS.Platform,
  path: string,
  installer: 'homebrew' | null
): string {
  if (path) {
    return installer === 'homebrew'
      ? 'Installed through Homebrew. Update to take a newer llama.cpp build.'
      : 'Found on this machine. The app will launch this binary.'
  }
  if (platform === 'darwin' || platform === 'linux') {
    return installer === 'homebrew'
      ? 'llama-server is not installed yet. Homebrew can install it for you.'
      : 'llama-server is not installed, and Homebrew was not found. Install Homebrew first, then install llama.cpp.'
  }
  return 'llama-server was not found on PATH. Install llama.cpp from its releases and make llama-server available on PATH; this app installs it automatically on macOS only.'
}
