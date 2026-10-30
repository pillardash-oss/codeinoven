/**
 * Detect and probe the `llama-server` binary the Llama.cpp settings page owns.
 *
 * Detection is read-only and short: it resolves the binary the way a shell
 * would (PATH, plus the Homebrew prefixes a GUI app does not inherit), reads
 * its version once, and reports which package manager could install or update
 * it here. Everything long-running (the install itself) is the user's to watch
 * in the embedded terminal, never an `exec` inside this service.
 */
import { execFile } from 'child_process'
import { access, constants } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { LlamaCppProbeResult, LlamaCppRuntimeStatus } from '../../lib/llama-cpp'

const run = promisify(execFile)

/** Everywhere llama.cpp lands on macOS and Linux, plus the user's own bin dirs. */
function candidateDirectories(): string[] {
  const fromPath = (process.env['PATH'] ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return [
    ...fromPath,
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/llama.cpp/bin',
    '/usr/local/bin',
    '/usr/local/opt/llama.cpp/bin',
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'bin')
  ]
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First `llama-server` the app can actually run, in the order a shell would. */
async function findLlamaServer(): Promise<string> {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const seen = new Set<string>()
  for (const directory of candidateDirectories()) {
    if (seen.has(directory)) continue
    seen.add(directory)
    const candidate = join(directory, name)
    if (await isExecutable(candidate)) return candidate
  }
  return ''
}

/** Homebrew's own binary, which is what installs and updates llama.cpp here. */
async function findHomebrew(): Promise<string> {
  if (process.platform === 'win32') return ''
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (await isExecutable(candidate)) return candidate
  }
  for (const directory of candidateDirectories()) {
    const candidate = join(directory, 'brew')
    if (await isExecutable(candidate)) return candidate
  }
  return ''
}

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

export async function detectLlamaCppRuntime(): Promise<LlamaCppRuntimeStatus> {
  const [path, brew] = await Promise.all([findLlamaServer(), findHomebrew()])
  const installer: 'homebrew' | null = brew ? 'homebrew' : null
  const version = path ? await readVersion(path) : ''
  return {
    platform: process.platform,
    installed: path.length > 0,
    path,
    version,
    installer,
    installerPath: brew,
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

const PROBE_TIMEOUT_MS = 2_500

/**
 * Ask a running server for its model list. This is the only thing that flips a
 * card to "running": a process that is alive but still loading a model is not
 * ready to answer turns, and the loaded id is what the card displays.
 */
export async function probeLlamaCppServer(baseUrl: string): Promise<LlamaCppProbeResult> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
  } catch {
    return { ready: false, models: [], error: 'The server is not answering yet' }
  }
  if (!response.ok) {
    return { ready: false, models: [], error: `The server answered ${response.status}` }
  }
  try {
    const body: unknown = await response.json()
    return { ready: true, models: readModelIds(body), error: '' }
  } catch {
    return { ready: false, models: [], error: 'The server answered with invalid JSON' }
  }
}

function readModelIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0 && id.length <= 512) ids.push(id)
  }
  return ids
}
