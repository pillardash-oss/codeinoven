import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Logger } from '../system/logger'
import { prepareHarnessInvocation } from '../drivers/harness-runtime'

/** How long `opencode2 serve` may take to announce its endpoint and password. */
const START_TIMEOUT_MS = 60_000
/** Grace period between SIGTERM and SIGKILL when tearing a server down. */
const SHUTDOWN_GRACE_MS = 2_000

/** Environment variable that makes `opencode2 serve` accept a chosen password. */
export const OPENCODE_V2_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD'
/** Environment variable carrying an inline V2 config document. */
export const OPENCODE_V2_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT'

/** Loopback endpoint plus the Basic-auth password this process authenticates with. */
export interface OpenCodeV2Endpoint {
  /** Base URL the server announced, e.g. `http://127.0.0.1:50725`. */
  baseUrl: string
  /** Password for the `opencode` Basic-auth user. */
  password: string
}

/** A live `opencode2 serve` process owned by one caller. */
export interface OpenCodeV2ServerHandle extends OpenCodeV2Endpoint {
  process: ChildProcess
  /** Idempotent teardown: SIGTERM, then SIGKILL after a bounded grace period. */
  close(): Promise<void>
}

const LISTENING_PATTERN = /^server listening on (\S+)$/u
const PASSWORD_PATTERN = /^server password (\S+)$/u

/**
 * Extract the endpoint from the lines `opencode2 serve` prints on stdout:
 *
 *     server listening on http://127.0.0.1:50725
 *     server password <value>
 *
 * `expectedPassword` is the password the caller installed through
 * `OPENCODE_SERVER_PASSWORD`. A server started that way prints only the
 * listening line, and the password line must then be unnecessary   waiting for
 * it would hang every start. Pure and dependency-free so it can be tested
 * against captured output.
 */
export function parseOpenCodeV2Handshake(
  output: string,
  expectedPassword?: string
): OpenCodeV2Endpoint | null {
  let baseUrl: string | null = null
  let announced: string | null = null
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const listening = LISTENING_PATTERN.exec(line)
    if (listening?.[1]) baseUrl = listening[1]
    const secret = PASSWORD_PATTERN.exec(line)
    if (secret?.[1]) announced = secret[1]
  }
  const password = announced ?? expectedPassword ?? null
  return baseUrl && password ? { baseUrl, password } : null
}

/** A fresh Basic-auth password for one spawned server, never logged. */
export function generateOpenCodeV2Password(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Spawn a private `opencode2 serve` process on an ephemeral loopback port and
 * resolve once it has announced its endpoint.
 *
 * The driver always installs its own `OPENCODE_SERVER_PASSWORD`, so the
 * password is known before the process starts and never has to be scraped off
 * stdout (where it would otherwise reach any log sink). The server is private
 * (`--port 0`), so it cannot collide with the user's own background service or
 * another driver instance. Callers must always `close()` the handle.
 */
export async function startOpenCodeV2Server(options: {
  command: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Extra config document merged on top of the user's own V2 config. */
  configContent?: string
  password?: string
  /** Label used in dev logs so several pooled servers stay distinguishable. */
  label?: string
}): Promise<OpenCodeV2ServerHandle> {
  const args = ['serve', '--hostname', '127.0.0.1', '--port', '0']
  const password = options.password ?? generateOpenCodeV2Password()
  const prepared = await prepareHarnessInvocation(options.command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: {
      ...options.env,
      [OPENCODE_V2_PASSWORD_ENV]: password,
      ...(options.configContent ? { [OPENCODE_V2_CONFIG_CONTENT_ENV]: options.configContent } : {})
    }
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
      const endpoint = parseOpenCodeV2Handshake(output, password)
      if (!endpoint) return
      settled = true
      clearTimeout(timer)
      Logger.dev(`opencode2 server up on ${endpoint.baseUrl}`, options.label ?? '')
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
