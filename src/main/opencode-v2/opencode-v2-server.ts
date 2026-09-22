import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { Logger } from '../system/logger'
import { prepareHarnessInvocation } from '../drivers/harness-runtime'

/** How long `opencode2 serve` may take to announce its endpoint and password. */
const START_TIMEOUT_MS = 30_000
/** Grace period between SIGTERM and SIGKILL when tearing a server down. */
const SHUTDOWN_GRACE_MS = 2_000

/** Loopback endpoint plus the Basic-auth password `opencode2 serve` announces. */
export interface OpenCodeV2Endpoint {
  /** Base URL the server announced, e.g. `http://127.0.0.1:50725`. */
  baseUrl: string
  /** Password for the `opencode` Basic-auth user. */
  password: string
}

/** A live `opencode2 serve` process owned by one discovery run. */
export interface OpenCodeV2ServerHandle extends OpenCodeV2Endpoint {
  process: ChildProcess
  /** Idempotent teardown: SIGTERM, then SIGKILL after a bounded grace period. */
  close(): Promise<void>
}

const LISTENING_PATTERN = /^server listening on (\S+)$/u
const PASSWORD_PATTERN = /^server password (\S+)$/u

/**
 * Extract the endpoint from the two lines `opencode2 serve` prints on stdout:
 *
 *     server listening on http://127.0.0.1:50725
 *     server password <value>
 *
 * Returns `null` until both lines have arrived   a partial buffer must never
 * yield a half-populated endpoint that would then fail every request with 401.
 * Pure and dependency-free so it can be tested against captured output.
 */
export function parseOpenCodeV2Handshake(output: string): OpenCodeV2Endpoint | null {
  let baseUrl: string | null = null
  let password: string | null = null
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const listening = LISTENING_PATTERN.exec(line)
    if (listening?.[1]) baseUrl = listening[1]
    const secret = PASSWORD_PATTERN.exec(line)
    if (secret?.[1]) password = secret[1]
  }
  return baseUrl && password ? { baseUrl, password } : null
}

/**
 * Spawn a private `opencode2 serve` process on an ephemeral loopback port and
 * resolve once it has announced its URL and password. The server is private
 * (`--port 0`), so it cannot collide with a background service or another
 * discovery run. Callers must always `close()` the returned handle.
 */
export async function startOpenCodeV2Server(options: {
  command: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}): Promise<OpenCodeV2ServerHandle> {
  const args = ['serve', '--hostname', '127.0.0.1', '--port', '0']
  const prepared = await prepareHarnessInvocation(options.command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  return new Promise<OpenCodeV2ServerHandle>((resolve, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
      env: prepared.env,
      shell: prepared.shell,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let settled = false
    let output = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`Timed out after ${START_TIMEOUT_MS}ms waiting for opencode2 server`))
    }, START_TIMEOUT_MS)

    const inspect = (text: string): void => {
      if (settled) return
      output += text
      const endpoint = parseOpenCodeV2Handshake(output)
      if (!endpoint) return
      settled = true
      clearTimeout(timer)
      Logger.dev(`opencode2 discovery server up on ${endpoint.baseUrl}`)
      resolve({ ...endpoint, process: child, close: () => stopChild(child) })
    }

    child.stdout?.on('data', (chunk: Buffer) => inspect(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      Logger.dev('opencode2 serve:', text.trim())
      inspect(text)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`opencode2 server exited before announcing its endpoint (code ${code})`))
    })
  })
}

/** Terminate a server process, escalating to SIGKILL after a bounded grace period. */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
    child.once('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
