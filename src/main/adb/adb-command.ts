/**
 * Locating and running the `adb` client for the app-owned Android target
 * capability.
 *
 * This module is the only place that knows where a copy of `adb` lives. Agents
 * must never call it themselves: a shell call an agent writes is invisible to
 * the target lease and races every other session (see the findings in
 * `.cio/work/adb-agent-interaction/FINDINGS.md`).
 *
 * The environment comes from `buildProcessEnvironment()` in
 * `src/main/drivers/cli-environment.ts`. Electron GUI processes do not inherit a
 * user's interactive-shell `PATH`, and `process.env` must never be handed to a
 * new external process (see `docs/APP-BIBLE.md` section 4.5).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildProcessEnvironment, resolveExecutablePath } from '../drivers/cli-environment'
import { Logger } from '../system/logger'

/** How long a single adb command may run before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 20_000
/** `uiautomator dump` on a large tree needs more room than a property read. */
export const TREE_COMMAND_TIMEOUT_MS = 45_000
/** Ceiling on collected stdout. A dumped tree is large but never unbounded. */
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024

/** A resolved adb client plus the SDK root it came from, when one was found. */
export interface AdbBinary {
  path: string
  sdkRoot?: string
  source: string
}

/** One finished adb invocation. */
export interface AdbRunResult {
  code: number | null
  stdout: string
  stderr: string
  /** True when the command was killed at its timeout. */
  timedOut: boolean
}

/** Raised when no usable adb client exists, with the paths that were tried. */
export class AdbUnavailableError extends Error {
  constructor(readonly attempted: string[]) {
    super(
      'No adb client was found. Install Android platform-tools, or set ANDROID_HOME to an Android SDK that contains platform-tools/adb.'
    )
    this.name = 'AdbUnavailableError'
  }
}

/** Raised when adb itself exits non-zero in a way the caller must see. */
export class AdbCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly result: AdbRunResult
  ) {
    const detail = result.timedOut
      ? `timed out after ${DEFAULT_TIMEOUT_MS}ms`
      : result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.code)}`
    super(`adb ${args.join(' ')} failed: ${detail}`)
    this.name = 'AdbCommandError'
  }
}

function sdkCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env['HOME'] ?? homedir()
  const localAppData = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
  const fromEnvironment = [env['ANDROID_HOME'], env['ANDROID_SDK_ROOT']].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )
  const standard =
    process.platform === 'win32'
      ? [join(localAppData, 'Android', 'Sdk'), join(home, 'Android', 'Sdk')]
      : process.platform === 'darwin'
        ? [join(home, 'Library', 'Android', 'sdk')]
        : [join(home, 'Android', 'Sdk'), join(home, 'Android', 'sdk'), join(home, 'android-sdk')]
  return [...fromEnvironment, ...standard]
}

function adbExecutableName(): string {
  return process.platform === 'win32' ? 'adb.exe' : 'adb'
}

/**
 * Resolve the adb client once per process. Order matters: an adb already on the
 * normalized PATH wins, then an SDK the user pointed at, then the standard SDK
 * locations, so a Homebrew or distro package is never shadowed by a stale SDK.
 */
let cachedBinary: AdbBinary | null = null

export function resolveAdbBinary(): AdbBinary {
  if (cachedBinary) return cachedBinary
  const env = buildProcessEnvironment()
  const executable = adbExecutableName()
  const attempted: string[] = []

  const onPath = resolveExecutablePath('adb', env)
  if (onPath) {
    cachedBinary = { path: onPath, source: 'PATH' }
    return cachedBinary
  }
  for (const root of sdkCandidates(env)) {
    const candidate = join(root, 'platform-tools', executable)
    attempted.push(candidate)
    if (existsSync(candidate)) {
      cachedBinary = { path: candidate, sdkRoot: root, source: 'Android SDK' }
      Logger.info('Resolved adb from an Android SDK location', { source: root })
      return cachedBinary
    }
  }
  throw new AdbUnavailableError(attempted)
}

/** Forget the cached client, so a client installed mid-session is picked up. */
export function resetAdbBinary(): void {
  cachedBinary = null
}

interface RunAdbOptions {
  /** Target serial, or `null` for a server-level command such as `devices -l`. */
  serial?: string | null
  timeoutMs?: number
  /** Collect stdout as bytes, for `exec-out screencap -p`. */
  binary?: boolean
  /** Treat a non-zero exit as an expected outcome instead of throwing. */
  tolerateFailure?: boolean
}

/**
 * Run one adb command and collect its output.
 *
 * `ADB_MDNS=0` keeps the client from probing the local network for wireless
 * targets the user never asked this app to find. `ANDROID_HOME` is set from the
 * resolved SDK so adb can locate its own platform-tools siblings.
 */
export function runAdb(
  args: string[],
  options: RunAdbOptions = {}
): Promise<AdbRunResult & { bytes: Buffer }> {
  const binary = resolveAdbBinary()
  const env = buildProcessEnvironment()
  if (binary.sdkRoot) {
    env['ANDROID_HOME'] = binary.sdkRoot
    env['ANDROID_SDK_ROOT'] = binary.sdkRoot
  }
  env['ADB_MDNS'] = '0'
  const fullArgs = options.serial ? ['-s', options.serial, ...args] : args
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const child = spawn(binary.path, fullArgs, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outBytes = 0
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_OUTPUT_BYTES) return
      outBytes += chunk.length
      outChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new Error(
          `adb could not be started from ${binary.path}: ${error.message}. The Android SDK may have moved or been removed.`
        )
      )
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const bytes = Buffer.concat(outChunks)
      const result = {
        code,
        stdout: bytes.toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
        bytes
      }
      if (code !== 0 && !options.tolerateFailure) {
        reject(new AdbCommandError(fullArgs, result))
        return
      }
      resolve(result)
    })
  })
}

/** Run one command against a specific target and return trimmed stdout. */
export async function runAdbOn(serial: string, args: string[]): Promise<string> {
  const result = await runAdb(args, { serial })
  return result.stdout.trim()
}
