/**
 * One native messaging host process, spoken to in Chromium's wire format.
 *
 * Chromium carries native messaging over the host's standard input and output as a
 * stream of messages, each a 4-byte length in the machine's own byte order
 * followed by that many bytes of UTF-8 JSON. The host's standard error is its log,
 * not part of the protocol. This is the whole of the framing, so a host that
 * Bitwarden's desktop installs works here exactly as it does in Chrome.
 *
 * Bounds are enforced rather than trusted: the host is a separate program the user
 * installed, and a length it claims cannot be allowed to make the app allocate an
 * arbitrary amount of memory. One message larger than Chromium's own limit, or one
 * that is not JSON at all, ends the connection instead of being buffered forever.
 *
 * Nothing here touches the app's main thread for long: the stream is read and
 * written through Node's own pipes, and only a fully-assembled message is handed on.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { endianness } from 'node:os'
import { Logger } from '../../system/logger'

/** The most a host may send in one message, which is Chromium's own 1 MiB limit
 *  for host-to-extension messages. */
const MAX_INBOUND_MESSAGE_BYTES = 1024 * 1024

/** The most the app will write in one message. Chromium's own limit is far higher,
 *  which is not a reason to let an extension ask for unbounded memory. */
const MAX_OUTBOUND_MESSAGE_BYTES = 64 * 1024 * 1024

/** Kept only so a host that writes an unbroken stream to stderr cannot grow the
 *  app without bound; the tail is what is logged. */
const MAX_STDERR_BYTES = 64 * 1024

export interface NativeHostProcessEvents {
  /** One complete message from the host. */
  onMessage: (message: unknown) => void
  /** The host is gone. `error` is null for a clean exit, a message otherwise. */
  onExit: (error: string | null) => void
}

/**
 * A spawned native messaging host.
 *
 * `start()` reports whether the process could be spawned at all; everything after
 * that is reported through `onExit`, exactly once, including a spawn that failed
 * asynchronously.
 */
export class NativeHostProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private exited = false
  private stopping = false
  private stderrTail = ''

  constructor(
    private readonly executablePath: string,
    private readonly events: NativeHostProcessEvents
  ) {}

  /** Spawn the host. False means it never started; `onExit` is not called then. */
  start(): boolean {
    try {
      const child = spawn(this.executablePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.child = child
      child.on('error', (error) => this.finish(error.message))
      child.on('exit', (code, signal) => {
        if (this.exited) return
        if (code === 0 || code === null) {
          this.finish(signal ? `the host was stopped by ${signal}` : null)
        } else {
          const detail = this.stderrTail.trim()
          this.finish(
            detail.length > 0
              ? `the host exited with code ${code}: ${detail}`
              : `the host exited with code ${code}`
          )
        }
      })
      child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
      child.stdout.on('error', () => this.finish('the host output could not be read'))
      child.stderr.on('data', (chunk: Buffer) => this.readStderr(chunk))
      child.stdin.on('error', () => this.finish('the host input could not be written'))
      return true
    } catch (error) {
      this.finish(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** Write one message to the host. Answers false when it could not be written. */
  send(message: unknown): boolean {
    const child = this.child
    if (!child || this.exited || child.stdin.destroyed) return false
    let payload: Buffer
    try {
      payload = Buffer.from(JSON.stringify(message), 'utf8')
    } catch {
      return false
    }
    if (payload.byteLength > MAX_OUTBOUND_MESSAGE_BYTES) return false
    const header = Buffer.alloc(4)
    writeLength(header, payload.byteLength)
    try {
      child.stdin.write(header)
      child.stdin.write(payload)
      return true
    } catch {
      return false
    }
  }

  /** Stop the host. Idempotent, and quiet about a process that already left. */
  kill(): void {
    const child = this.child
    if (!child || this.exited) return
    // A disconnect the extension asked for is not a failure, so the exit it causes
    // is reported as a clean one and never logged as a host that ended badly.
    this.stopping = true
    try {
      child.kill()
    } catch {
      // The process is gone; the exit handler will settle this port.
    }
    // A host that ignores SIGTERM must not hold a pipe open forever.
    const timer = setTimeout(() => {
      if (this.exited) return
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, 2000)
    timer.unref?.()
  }

  private read(chunk: Buffer): void {
    if (this.exited) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 4) return
      const length = readLength(this.buffer)
      if (length > MAX_INBOUND_MESSAGE_BYTES) {
        this.finish('the host sent a message larger than the native messaging limit')
        return
      }
      if (this.buffer.length < 4 + length) return
      const body = this.buffer.subarray(4, 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(4 + length)
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        this.finish('the host sent a message that is not JSON')
        return
      }
      this.events.onMessage(message)
    }
  }

  private readStderr(chunk: Buffer): void {
    this.stderrTail += chunk.toString('utf8')
    if (this.stderrTail.length > MAX_STDERR_BYTES) {
      this.stderrTail = this.stderrTail.slice(this.stderrTail.length - MAX_STDERR_BYTES)
    }
  }

  private finish(error: string | null): void {
    if (this.exited) return
    this.exited = true
    const child = this.child
    this.child = null
    if (child) {
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.stdin.removeAllListeners()
    }
    const reported = this.stopping ? null : error
    if (reported) {
      Logger.dev('Native messaging host ended:', {
        executablePath: this.executablePath,
        error: reported,
        stderr: this.stderrTail.trim().slice(-2000)
      })
    }
    this.events.onExit(reported)
  }
}

function readLength(buffer: Buffer): number {
  return endianness() === 'LE' ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0)
}

function writeLength(header: Buffer, length: number): void {
  if (endianness() === 'LE') header.writeUInt32LE(length, 0)
  else header.writeUInt32BE(length, 0)
}
