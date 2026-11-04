/// <reference types="electron-vite/node" />
import type { Worker } from 'node:worker_threads'
import createPngWorker from './display-png-worker.ts?nodeWorker'
import type { PngEncodeMessage, PngEncodeReply } from './display-png-worker'

/**
 * The main-process side of off-main PNG encoding.
 *
 * One worker serves every desktop session and is created when the first one opens,
 * so an app that never mirrors a screen holds no thread for it. A session retains
 * an encoder and releases it when it is disposed; when the last holder goes, the
 * worker is terminated, which is what keeps a closed panel from leaving an idle
 * thread behind for the rest of the session.
 */

/** A wedged encode is an abandoned one: no frame is worth waiting on forever. */
const ENCODE_TIMEOUT_MS = 10_000

export interface OffMainPngEncoder {
  encode(bitmap: Buffer, width: number, height: number): Promise<Uint8Array>
  release(): void
}

interface PendingEncode {
  resolve: (png: Uint8Array) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class PngEncoderPool {
  private worker: Worker | null = null
  private holders = 0
  private sequence = 0
  private readonly pending = new Map<number, PendingEncode>()

  /** Take one encoder; the worker starts with the first holder. */
  retain(): OffMainPngEncoder {
    this.holders += 1
    this.ensureWorker()
    let released = false
    return {
      encode: (bitmap, width, height) => this.request(this.ensureWorker(), bitmap, width, height),
      release: () => {
        if (released) return
        released = true
        this.holders -= 1
        if (this.holders <= 0) this.stop()
      }
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = createPngWorker({ name: 'codeinoven-display-png' })
    worker.on('message', (reply: PngEncodeReply) => this.settle(reply))
    // A worker that dies takes its answers with it: fail them now rather than
    // leaving a session waiting on a frame that can never arrive.
    worker.on('error', (error: Error) => this.failAll(error))
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null
      this.failAll(new Error('the display encoder stopped'))
    })
    this.worker = worker
    return worker
  }

  private request(
    worker: Worker,
    bitmap: Buffer,
    width: number,
    height: number
  ): Promise<Uint8Array> {
    this.sequence += 1
    const id = this.sequence
    // The pixels are copied into the worker's own buffer, so the caller's bitmap is
    // never read after this call and there is nothing to hand back.
    const message: PngEncodeMessage = {
      id,
      bitmap: bitmap.buffer.slice(
        bitmap.byteOffset,
        bitmap.byteOffset + bitmap.byteLength
      ) as ArrayBuffer,
      width,
      height
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the display encoder did not answer in time'))
        // One unresponsive encode means the worker is gone, not slow: replace it so
        // the next frame is not queued behind it forever.
        this.stop()
      }, ENCODE_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage(message, [message.bitmap])
    })
  }

  private settle(reply: PngEncodeReply): void {
    const entry = this.pending.get(reply.id)
    if (!entry) return
    this.pending.delete(reply.id)
    clearTimeout(entry.timer)
    if (reply.png) entry.resolve(reply.png)
    else entry.reject(new Error(reply.error ?? 'the display encoder produced no image'))
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private stop(): void {
    this.failAll(new Error('the display encoder was stopped'))
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate()
  }
}

const pool = new PngEncoderPool()

/** Retain an encoder for one desktop capture session. */
export function retainPngEncoder(): OffMainPngEncoder {
  return pool.retain()
}
