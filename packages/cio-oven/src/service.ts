import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serviceBundleRevision } from '../../../src/main/ovens/oven-service-bundle'
import { OVEN_PROTOCOL_VERSION } from '../../../src/lib/ovens'
import type { OvenLayout } from './paths'

/**
 * The service bundle ships in `dist`, beside the built CLI.
 *
 * Resolving through `..` keeps one path for both layouts: `dist/cli.mjs`
 * resolves it to `<package>/dist/service.mjs`, and running the TypeScript
 * source during development resolves the same file.
 */
const BUNDLE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'service.mjs')

export interface ServiceBundle {
  source: string
  revision: string
}

export interface ServiceProbe {
  protocolVersion: number
  serviceRevision: string
  platform: string
  architecture: string
  nodeVersion: string
  activeRuns: number
}

export interface ServiceState {
  installed: boolean
  running: boolean
  pid: number | null
  probe: ServiceProbe | null
}

/** Read the bundle this package published, normalized and hashed the app's way. */
export async function readBundle(): Promise<ServiceBundle> {
  const source = await readFile(BUNDLE_FILE, 'utf8')
  return { source, revision: serviceBundleRevision(source) }
}

/**
 * Install the bundle under the data root.
 *
 * The staged file is verified against the revision the package ships before it
 * replaces a working service, so a truncated or corrupted download can never
 * become the file the app runs.
 */
export async function installBundle(layout: OvenLayout, bundle: ServiceBundle): Promise<void> {
  await mkdir(dirname(layout.serviceFile), { recursive: true, mode: 0o700 })
  const staged = `${layout.serviceFile}.${process.pid}.next`
  try {
    await writeFile(staged, bundle.source, { mode: 0o600 })
    const actual = serviceBundleRevision(await readFile(staged, 'utf8'))
    if (actual !== bundle.revision)
      throw new Error('The Oven service failed its integrity check after it was written.')
    if (process.platform !== 'win32') await chmod(staged, 0o600)
    await rename(staged, layout.serviceFile)
  } catch (error) {
    await rm(staged, { force: true })
    throw error
  }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run the installed service with this CLI's own Node, so one runtime is in charge. */
function runService(
  layout: OvenLayout,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
  revision?: string
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [layout.serviceFile, ...args], {
      cwd: layout.dataRoot,
      env: {
        ...process.env,
        CODEINOVEN_OVEN_DATA_ROOT: layout.dataRoot,
        ...(revision ? { CODEINOVEN_OVEN_REVISION: revision } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('The Oven service did not answer in time.'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function parseEnvelope(output: string): unknown {
  const trimmed = output.trim()
  const line = trimmed.slice(trimmed.lastIndexOf('\n') + 1)
  let parsed: { ok?: boolean; value?: unknown; error?: string }
  try {
    parsed = JSON.parse(line) as { ok?: boolean; value?: unknown; error?: string }
  } catch {
    throw new Error('The Oven service answered in an unexpected format.')
  }
  if (parsed.ok !== true) throw new Error(parsed.error || 'The Oven request failed.')
  return parsed.value
}

/** Narrow a probe response to the fields this CLI reports on. */
function toServiceProbe(value: unknown): ServiceProbe {
  if (!value || typeof value !== 'object') throw new Error('The Oven service returned no probe.')
  const raw = value as Record<string, unknown>
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  const count = typeof raw['activeRuns'] === 'number' ? raw['activeRuns'] : 0
  return {
    protocolVersion: typeof raw['protocolVersion'] === 'number' ? raw['protocolVersion'] : 0,
    serviceRevision: text('serviceRevision'),
    platform: text('platform'),
    architecture: text('architecture'),
    nodeVersion: text('nodeVersion'),
    activeRuns: count
  }
}

/**
 * Start the service and return its live probe.
 *
 * The service's own `ensure` decides whether an already-running daemon can be
 * reused, so a repeated `start` with the same revision is a no-op instead of a
 * restart that would drop connected runs.
 */
export async function ensureService(
  layout: OvenLayout,
  bundle: ServiceBundle
): Promise<ServiceProbe> {
  // The revision travels with the request exactly as the app's own install sends
  // it, so the running service reports the revision the app compares against.
  const result = await runService(layout, ['ensure'], undefined, 90_000, bundle.revision)
  if (result.code !== 0 && !result.stdout.trim())
    throw new Error(
      result.stderr.trim() || 'The Oven service did not start. Check the Node.js runtime.'
    )
  return toServiceProbe(parseEnvelope(result.stdout))
}

/** Read the running service's probe, or `null` when nothing answers. */
export async function probeService(layout: OvenLayout): Promise<ServiceProbe | null> {
  try {
    const result = await runService(
      layout,
      ['request'],
      `${JSON.stringify({ method: 'probe', protocolVersion: OVEN_PROTOCOL_VERSION })}\n`,
      30_000
    )
    if (result.code !== 0 && !result.stdout.trim()) return null
    return toServiceProbe(parseEnvelope(result.stdout))
  } catch {
    return null
  }
}

async function pidFromLock(layout: OvenLayout): Promise<number | null> {
  try {
    const pid = Number((await readFile(layout.pidFile, 'utf8')).trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What this machine currently has installed and running for one data root. */
export async function serviceState(layout: OvenLayout): Promise<ServiceState> {
  const installed = await readFile(layout.serviceFile, 'utf8').then(
    () => true,
    () => false
  )
  const pid = await pidFromLock(layout)
  const probe = await probeService(layout)
  return {
    installed,
    running: probe !== null || (pid !== null && processAlive(pid)),
    pid,
    probe
  }
}

/**
 * Stop the service and wait for it to actually leave.
 *
 * The request path is preferred because it lets the service refuse while runs
 * are active. A leftover lock with no live process is cleaned up so the next
 * `start` is not blocked by a stale pid.
 */
export async function stopService(layout: OvenLayout): Promise<'stopped' | 'not-running'> {
  const installed = await readFile(layout.serviceFile, 'utf8').then(
    () => true,
    () => false
  )
  if (installed) {
    const result = await runService(
      layout,
      ['request'],
      `${JSON.stringify({ method: 'shutdown', protocolVersion: OVEN_PROTOCOL_VERSION })}\n`,
      30_000
    )
    if (result.code === 0 && result.stdout.trim()) {
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(100)
        if ((await pidFromLock(layout)) === null) return 'stopped'
      }
      throw new Error('The Oven service did not stop. Check for a stuck process and retry.')
    }
  }
  const pid = await pidFromLock(layout)
  if (pid !== null && processAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* It exited between the check and the signal. */
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(100)
      if (!processAlive(pid)) break
    }
    if (processAlive(pid)) throw new Error(`The Oven service process ${pid} is still running.`)
    return 'stopped'
  }
  await rm(layout.pidFile, { force: true })
  return 'not-running'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
