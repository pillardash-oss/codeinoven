import type { IPty } from 'node-pty'

const CHUNK_SIZE = 16 * 1024
const WINDOW_SIZE = 64 * 1024
const HIGH_WATER = 128 * 1024

/** Command output is paced and acknowledged after terminal parsing. The PTY
 * pauses at the high-water mark instead of filling the renderer IPC queue. */
export class PtyOutputBuffer {
  private pending = ''
  private outstanding = 0
  private paused = false
  private timer?: ReturnType<typeof setTimeout>
  private finished?: () => void
  private disposed = false

  constructor(
    private readonly process: Pick<IPty, 'pause' | 'resume'>,
    private readonly send: (data: string) => void
  ) {}

  push(data: string): void {
    if (this.disposed) return
    this.pending += data
    if (!this.paused && this.pending.length + this.outstanding >= HIGH_WATER) {
      this.process.pause()
      this.paused = true
    }
    this.schedule()
  }

  acknowledge(length: number): void {
    if (!Number.isSafeInteger(length) || length <= 0 || length > this.outstanding) return
    this.outstanding -= length
    if (this.paused && this.pending.length + this.outstanding < WINDOW_SIZE) {
      this.paused = false
      if (!this.finished) this.process.resume()
    }
    this.schedule()
  }

  end(finished: () => void): void {
    if (this.disposed) {
      finished()
      return
    }
    this.finished = finished
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = ''
    this.finished = undefined
  }

  private schedule(): void {
    if (this.disposed || this.timer) return
    if (!this.pending && this.outstanding === 0 && this.finished) {
      const finished = this.finished
      this.dispose()
      finished()
      return
    }
    if (!this.pending || this.outstanding >= WINDOW_SIZE) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      let length = Math.min(CHUNK_SIZE, this.pending.length, WINDOW_SIZE - this.outstanding)
      const last = this.pending.charCodeAt(length - 1)
      if (last >= 0xd800 && last <= 0xdbff && length < this.pending.length) length -= 1
      if (length === 0) return // Wait for an acknowledgment rather than splitting a surrogate pair.
      const chunk = this.pending.slice(0, length)
      this.pending = this.pending.slice(length)
      this.outstanding += length
      this.send(chunk)
      this.schedule()
    }, 16)
  }
}
