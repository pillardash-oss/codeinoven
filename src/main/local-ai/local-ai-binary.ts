/**
 * Finding the binaries a local inference engine runs on, and the package manager
 * that installs it.
 *
 * Both engines the app manages are located the same way: the directories a shell
 * would search plus the Homebrew prefixes a GUI app does not inherit. Detection is
 * read-only and cheap; everything long-running (the install itself) is the user's
 * to watch in the embedded terminal, never an `exec` inside this module.
 */
import { execFile } from 'child_process'
import { access, constants } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

/** Everywhere a local server lands on macOS and Linux, plus the user's own bin dirs. */
export function candidateDirectories(): string[] {
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

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First executable of this name the app can actually run, in shell order. */
export async function findExecutable(name: string): Promise<string> {
  const file = process.platform === 'win32' ? `${name}.exe` : name
  const seen = new Set<string>()
  for (const directory of candidateDirectories()) {
    if (seen.has(directory)) continue
    seen.add(directory)
    const candidate = join(directory, file)
    if (await isExecutable(candidate)) return candidate
  }
  return ''
}

/** Homebrew's own binary, which is what installs and updates either engine here. */
export async function findHomebrew(): Promise<string> {
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

export async function firstExecutable(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  return ''
}

/**
 * Ask the installer whether a newer build of this formula exists.
 *
 * Homebrew reports an out-of-date formula with a *non-zero* exit code, so the
 * answer is read from stdout on success and on failure alike. `HOMEBREW_NO_AUTO_UPDATE`
 * keeps the check to the local formula cache: a settings page must never decide
 * whether an update exists by first downloading Homebrew's whole index.
 */
export async function readAvailableUpdate(
  brew: string,
  formula: string
): Promise<{ updateAvailable: boolean; latestVersion: string }> {
  if (!brew) return { updateAvailable: false, latestVersion: '' }
  try {
    const { stdout } = await run(brew, ['outdated', '--json=v2', formula], {
      timeout: 20_000,
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' }
    })
    return parseOutdated(stdout)
  } catch (error) {
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error
        ? String((error as { stdout?: unknown }).stdout ?? '')
        : ''
    return parseOutdated(stdout)
  }
}

function parseOutdated(stdout: string): { updateAvailable: boolean; latestVersion: string } {
  if (stdout.trim().length === 0) return { updateAvailable: false, latestVersion: '' }
  try {
    const body: unknown = JSON.parse(stdout)
    if (typeof body !== 'object' || body === null)
      return { updateAvailable: false, latestVersion: '' }
    const formulae = (body as { formulae?: unknown }).formulae
    if (!Array.isArray(formulae) || formulae.length === 0) {
      return { updateAvailable: false, latestVersion: '' }
    }
    const first = formulae[0]
    if (typeof first !== 'object' || first === null) {
      return { updateAvailable: false, latestVersion: '' }
    }
    const latest = (first as { current_version?: unknown }).current_version
    return {
      updateAvailable: true,
      latestVersion: typeof latest === 'string' ? latest.slice(0, 64) : ''
    }
  } catch {
    return { updateAvailable: false, latestVersion: '' }
  }
}

/** Where `lsof` lives, for the port lookups below. */
const LSOF_PATHS = ['/usr/sbin/lsof', '/usr/bin/lsof']

/** PIDs listening on `port`, empty when nothing does (`lsof` exits non-zero). */
export async function listeningPids(port: number): Promise<number[]> {
  const lsof = await firstExecutable(LSOF_PATHS)
  if (!lsof) return []
  try {
    const { stdout } = await run(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      timeout: 5_000
    })
    return stdout
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/** The command line a process was started with, empty when it has already exited. */
export async function processCommand(pid: number): Promise<string> {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
      timeout: 5_000
    })
    return stdout.trim()
  } catch {
    return ''
  }
}
