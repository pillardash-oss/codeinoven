import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { constants, setPriority } from 'node:os'
import { downloadFileResumable } from '../util/resumable-download'
import { Logger } from '../system/logger'
import { buildProcessEnvironment } from './cli-environment'
import {
  findWindowsGitRuntime,
  invalidateWindowsGitDiscovery,
  managedWindowsGitDirectory,
  selectedWindowsGitRuntime,
  windowsGitBins,
  windowsPathValue,
  windowsGitRuntimeAt,
  type WindowsGitRuntime
} from './windows-git-paths'

interface PortableGitAsset {
  url: string
  bytes: number
  sha256: string
}

let pending: Promise<WindowsGitRuntime> | undefined
let failed: { until: number; error: Error } | undefined
let backgroundPreparation: Promise<void> | undefined

/** One boot-time task, also safe to trigger from an early interactive launch. */
export function startWindowsGitPreparation(
  env: NodeJS.ProcessEnv = buildProcessEnvironment()
): void {
  if (process.platform !== 'win32' || backgroundPreparation) return
  backgroundPreparation = ensureWindowsGitRuntime(env)
    .then(() => undefined)
    .catch((error: unknown) => Logger.error('Windows Git background preparation failed', error))
    .finally(() => {
      backgroundPreparation = undefined
    })
}

/** Interactive callers may discover installed tools, but never await a download. */
export async function prepareWindowsGitRuntime(
  env: NodeJS.ProcessEnv = buildProcessEnvironment()
): Promise<WindowsGitRuntime | null> {
  if (process.platform !== 'win32') return null
  startWindowsGitPreparation(env)
  const selected = selectedWindowsGitRuntime()
  if (selected) return selected
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      findWindowsGitRuntime(env),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 750)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Validate metadata from the official stable release before downloading code. */
export function portableGitAsset(value: unknown, arch: string): PortableGitAsset {
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Portable Git requires 64-bit Windows.')
  if (!value || typeof value !== 'object' || !('assets' in value) || !Array.isArray(value.assets))
    throw new Error('The Git for Windows release metadata is invalid.')
  if (('prerelease' in value && value.prerelease) || ('draft' in value && value.draft))
    throw new Error('A stable Git for Windows release is required.')
  const suffix = arch === 'arm64' ? 'arm64' : '64-bit'
  for (const asset of value.assets as unknown[]) {
    if (!asset || typeof asset !== 'object') continue
    const entry = asset as Record<string, unknown>
    if (
      typeof entry['name'] !== 'string' ||
      !new RegExp(`^PortableGit-[\\d.]+-${suffix}\\.7z\\.exe$`, 'u').test(entry['name'])
    )
      continue
    const url = entry['browser_download_url']
    const bytes = entry['size']
    const digest = entry['digest']
    if (
      typeof url !== 'string' ||
      !url.startsWith('https://github.com/git-for-windows/git/releases/download/')
    )
      throw new Error('The Portable Git download is not an official release asset.')
    if (
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 128 * 1024 * 1024
    )
      throw new Error('The Portable Git download size is invalid.')
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new Error('The Portable Git release has no SHA-256 checksum.')
    return { url, bytes, sha256: digest.slice('sha256:'.length) }
  }
  throw new Error('No Portable Git release is available for this Windows architecture.')
}

async function extractPortableGit(
  executable: string,
  destination: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-y', '-gm2', `-InstallPath=${destination}`], {
      env,
      windowsHide: true,
      stdio: 'ignore'
    })
    if (child.pid) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        /* Best effort. */
      }
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Portable Git extraction timed out. Retry the connection.'))
    }, 120_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else
        reject(new Error(`Portable Git extraction failed (${String(code)}). Retry the connection.`))
    })
  })
}

async function installPortableGit(env: NodeJS.ProcessEnv): Promise<WindowsGitRuntime> {
  const destination = managedWindowsGitDirectory()
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, 'install-'))
  try {
    Logger.info('Preparing private Git for Windows runtime')
    const response = await fetch(
      'https://api.github.com/repos/git-for-windows/git/releases/latest',
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CodeInOven' },
        signal: AbortSignal.timeout(20_000)
      }
    )
    if (!response.ok)
      throw new Error(`Git for Windows release lookup failed (HTTP ${response.status}).`)
    const asset = portableGitAsset((await response.json()) as unknown, process.arch)
    const archive = join(staging, 'PortableGit.7z.exe')
    await downloadFileResumable({
      url: asset.url,
      destination: archive,
      expectedBytes: asset.bytes,
      checksum: { algorithm: 'sha256', encoding: 'hex', digest: asset.sha256 },
      signal: AbortSignal.timeout(300_000),
      responseTimeoutMs: 20_000
    })
    const unpacked = join(staging, 'portable')
    await extractPortableGit(archive, unpacked, env)
    if (!(await windowsGitRuntimeAt(unpacked)))
      throw new Error('Portable Git is missing Bash, Git or OpenSSH.')
    try {
      // Publish only a complete installation. A concurrent process can win safely.
      await rename(unpacked, destination)
    } catch (error) {
      if (!(await windowsGitRuntimeAt(destination))) throw error
    }
    invalidateWindowsGitDiscovery()
    const runtime = await windowsGitRuntimeAt(destination)
    if (!runtime) throw new Error('Portable Git installation could not be verified.')
    await findWindowsGitRuntime(buildProcessEnvironment(env))
    Logger.info('Private Git for Windows runtime is ready')
    return runtime
  } finally {
    await rm(staging, { recursive: true, force: true }).catch((error: unknown) => {
      Logger.dev('Portable Git staging cleanup failed', error)
    })
  }
}

/** Concurrent startup/SSH requests share setup; failures have a retry cooldown. */
export async function ensureWindowsGitRuntime(
  env: NodeJS.ProcessEnv = buildProcessEnvironment()
): Promise<WindowsGitRuntime | null> {
  if (process.platform !== 'win32') return null
  if (pending) return pending
  pending = (async () => {
    const existing = await findWindowsGitRuntime(env)
    if (existing) return existing
    if (failed && Date.now() < failed.until) throw failed.error
    return installPortableGit(env)
  })()
    .then((runtime) => {
      // Existing main-process tools and subsequently launched harnesses must
      // see the discovered runtime without an application restart.
      const paths = [...windowsGitBins(runtime.root), ...windowsPathValue(process.env).split(';')]
      const seen = new Set<string>()
      process.env['PATH'] = paths
        .filter((entry) => {
          if (!entry || seen.has(entry.toLowerCase())) return false
          seen.add(entry.toLowerCase())
          return true
        })
        .join(';')
      process.env['CLAUDE_CODE_GIT_BASH_PATH'] = runtime.bash
      return runtime
    })
    .catch((cause: unknown) => {
      if (failed?.error === cause) throw cause
      const detail = cause instanceof Error ? cause.message : String(cause)
      const error = new Error(
        `Windows developer tools could not be prepared. Check your internet connection and retry. ${detail}`,
        { cause }
      )
      failed = { until: Date.now() + 60_000, error }
      throw error
    })
    .finally(() => {
      pending = undefined
    })
  return pending
}
