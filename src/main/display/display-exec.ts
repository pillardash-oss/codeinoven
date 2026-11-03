import { spawn } from 'node:child_process'

/**
 * One bounded child process, run without a shell.
 *
 * Every device adapter needs the same shape: run a command, collect its bytes,
 * give up when it hangs, and be able to kill it the moment the panel stops
 * wanting frames. `execFile` cannot be cancelled after the fact and its buffer
 * ceiling is a foot-gun for a 1080x2400 PNG, so the collector is here once.
 */
export interface CaptureCommand {
  /** Resolves with stdout, rejects with the process's own message on failure. */
  promise: Promise<Buffer>
  /** Terminate the child, if it is still running. */
  cancel: () => void
}

/** Ceiling for one capture's stdout. A full-resolution device PNG fits well inside. */
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024

export function captureCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number
): CaptureCommand {
  let child: ReturnType<typeof spawn> | null = null
  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancel = (): void => undefined

  const promise = new Promise<Buffer>((resolve, reject) => {
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      action()
    }
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      return
    }
    const chunks: Buffer[] = []
    let collected = 0
    let stderr = ''
    cancel = () => {
      child?.kill('SIGKILL')
      finish(() => reject(new Error(`${command} was cancelled`)))
    }
    timer = setTimeout(() => {
      child?.kill('SIGKILL')
      finish(() => reject(new Error(`${command} did not answer within ${timeoutMs} ms`)))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      collected += chunk.byteLength
      // A device that floods stdout is a bug in the capture, not a frame: refuse
      // it instead of growing this process's heap without a bound.
      if (collected > MAX_CAPTURE_BYTES) {
        child?.kill('SIGKILL')
        finish(() => reject(new Error(`${command} produced more than a frame's worth of bytes`)))
        return
      }
      chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // Kept short: this text becomes an on-screen sentence, not a log dump.
      if (stderr.length < 400) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split('\n').at(-1) ?? ''
        finish(() =>
          reject(new Error(detail || `${command} exited with code ${code ?? 'unknown'}`))
        )
        return
      }
      finish(() => resolve(Buffer.concat(chunks)))
    })
  })

  return { promise, cancel }
}

/** Run one command and keep only its text, for the discovery listings. */
export async function captureText(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<string> {
  const result = await captureCommand(command, args, timeoutMs).promise
  return result.toString('utf8')
}
