import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { OvenSshProtection } from '../../lib/ovens'
import type { OvenSshInvocation } from './oven-ssh'

const execute = promisify(execFile)
/** OpenSSH hybrids: prefer ML-KEM, then supported SNTRUP names. https://www.openssh.org/pq.html */
const POST_QUANTUM_KEX = [
  'mlkem768x25519-sha256',
  'sntrup761x25519-sha512',
  'sntrup761x25519-sha512@openssh.com'
] as const
const clientAlgorithms = new Map<string, Promise<string[]>>()

/** Query once per client, off the main thread. Never offer an unsupported name. */
export async function postQuantumKeyExchangeOptions(
  executable: string,
  env: NodeJS.ProcessEnv,
  allowClassicalKeyExchange: boolean
): Promise<string[]> {
  if (allowClassicalKeyExchange) return []
  let pending = clientAlgorithms.get(executable)
  if (!pending) {
    pending = execute(executable, ['-Q', 'kex'], {
      env,
      timeout: 5_000,
      maxBuffer: 32 * 1024,
      windowsHide: true
    }).then(({ stdout }) => {
      const supported = new Set(stdout.trim().split(/\s+/u))
      return POST_QUANTUM_KEX.filter((algorithm) => supported.has(algorithm))
    })
    clientAlgorithms.set(executable, pending)
    void pending.catch(() => clientAlgorithms.delete(executable))
  }
  const algorithms = await pending.catch(() => {
    throw new Error(
      'Could not check this computer’s SSH algorithms. Update its OpenSSH client and retry.'
    )
  })
  if (!algorithms.length)
    throw new Error(
      'This computer’s SSH client cannot use post-quantum key exchange. Upgrade OpenSSH and restart CodeInOven, or explicitly allow classical key exchange in this Oven’s connection settings.'
    )
  return ['-o', `KexAlgorithms=${algorithms.join(',')}`]
}

/**
 * Verify one authenticated handshake without borrowing a multiplexed session.
 * Only public algorithm/version metadata survives; verbose SSH output, credential
 * paths and remote diagnostics are never returned or logged.
 */
export function inspectSshProtection(
  launch: OvenSshInvocation,
  signal?: AbortSignal
): Promise<OvenSshProtection> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ state: 'unverified' })
      return
    }
    const child = spawn(
      launch.executable,
      ['-v', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...launch.args],
      { env: launch.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let tail = ''
    let keyExchange: string | undefined
    let serverVersion: string | undefined
    let settled = false
    const abort = (): void => {
      child.kill('SIGKILL')
    }
    const timer = setTimeout(abort, 15_000)
    const finish = (authenticated: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(
        authenticated && keyExchange
          ? {
              state: POST_QUANTUM_KEX.some((algorithm) => algorithm === keyExchange)
                ? 'post-quantum'
                : 'classical',
              keyExchange,
              ...(serverVersion ? { serverVersion } : {})
            }
          : { state: 'unverified' }
      )
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stderr.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4096)
      keyExchange ??= /(?:^|\n)debug\d: kex: algorithm: ([a-zA-Z0-9@._+-]+)\r?\n/u.exec(tail)?.[1]
      serverVersion ??=
        /(?:^|\n)debug\d: Remote protocol version [^\r\n]+, remote software version ([a-zA-Z0-9._+-]+)[^\r\n]*\r?\n/u.exec(
          tail
        )?.[1]
    })
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0 && !signal?.aborted))
  })
}
