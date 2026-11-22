import type { IPty } from 'node-pty'

/**
 * Paces a shell's output to the renderer so a chatty process cannot flood IPC.
 *
 * A pseudo-terminal hands its output over in whatever sizes the child writes,
 * and a build, a watch task or a test runner writes thousands of tiny pieces
 * (one line, one spinner frame, one download progress tick). Forwarding each
 * piece as its own `webContents.send` cost one structured clone, one IPC
 * message, one renderer task and one WASM terminal write per piece: on a loaded
 * machine the renderer spent its whole event loop on the queue and the window
 * felt stuck while a build ran, even though the build itself was doing the real
 * work.
 *
 * So output is gathered for one frame and sent as one message. Nothing is
 * dropped, reordered or truncated: the renderer parses the same bytes, just in
 * fewer, larger pieces.
 *
 * The child is paused when far more output is waiting than one frame can carry,
 * which is what a real terminal does when its input buffer fills (the process
 * blocks in `write` instead of the app growing without bound). The cap is high
 * enough that normal shells never reach it, and a pause always ends on the next
 * flush, because draining depends only on this timer, never on the renderer
 * acknowledging anything: a hidden or busy window can delay output but can
 * never deadlock the child.
 */

/** How long output waits for company before it is sent. One frame. */
export const PTY_OUTPUT_FLUSH_MS = 16
/** Largest single IPC payload, in UTF-16 code units (~64 KiB of ASCII). */
export const PTY_OUTPUT_CHUNK_CHARS = 64 * 1024
/** How many chunks one tick may send, so a burst cannot take the whole frame. */
const MAX_CHUNKS_PER_TICK = 4
/** Waiting output above this pauses the child until the next drain. */
export const PTY_OUTPUT_HIGH_WATER_CHARS = 512 * 1024
/** Waiting output below this resumes it. */
export const PTY_OUTPUT_LOW_WATER_CHARS = 128 * 1024

export class PtyOutputCoalescer {
  private pending = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private paused = false
  private disposed = false

  constructor(
    private readonly process: Pick<IPty, 'pause' | 'resume'>,
    private readonly send: (data: string) => void
  ) {}

  /** Queue output for the next frame. */
  push(data: string): void {
    if (this.disposed || data.length === 0) return
    this.pending += data
    if (!this.paused && this.pending.length >= PTY_OUTPUT_HIGH_WATER_CHARS) {
      this.process.pause()
      this.paused = true
    }
    this.arm()
  }

  /** Send everything that is waiting right now, ahead of a `pty:exit` or a
   *  stop, so the last thing a process printed is never lost. */
  flush(): void {
    this.disarm()
    while (!this.disposed && this.pending.length > 0) this.sendOne()
  }

  /** Stop pacing and drop what is still waiting. Only for a session that is
   *  already gone: `flush()` is what preserves its last words. */
  dispose(): void {
    this.disarm()
    this.pending = ''
    this.resume()
    this.disposed = true
  }

  private arm(): void {
    if (this.timer !== undefined || this.disposed || this.pending.length === 0) return
    this.timer = setTimeout(() => this.tick(), PTY_OUTPUT_FLUSH_MS)
    // Never hold the event loop open: a quit stops sessions explicitly.
    this.timer.unref()
  }

  private disarm(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private tick(): void {
    this.timer = undefined
    for (let sent = 0; sent < MAX_CHUNKS_PER_TICK && this.pending.length > 0; sent++) {
      this.sendOne()
    }
    this.arm()
  }

  private sendOne(): void {
    let length = Math.min(PTY_OUTPUT_CHUNK_CHARS, this.pending.length)
    // Never split a surrogate pair: half of one in each message is a broken
    // character in the terminal, and the icon fonts this app renders are in
    // that range.
    const last = this.pending.charCodeAt(length - 1)
    if (last >= 0xd800 && last <= 0xdbff && length < this.pending.length) length -= 1
    if (length <= 0) return
    const chunk = this.pending.slice(0, length)
    this.pending = this.pending.slice(length)
    this.send(chunk)
    if (this.paused && this.pending.length <= PTY_OUTPUT_LOW_WATER_CHARS) this.resume()
  }

  private resume(): void {
    if (!this.paused) return
    this.paused = false
    this.process.resume()
  }
}
