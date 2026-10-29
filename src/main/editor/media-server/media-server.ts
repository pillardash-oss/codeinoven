/**
 * The main-process half of the media server: a URL per file, and a worker that
 * does the streaming.
 *
 * A preview URL the renderer can load is `http://127.0.0.1:<port>/media/<id>?token=<token>`,
 * where `<id>` is a grant the worker holds and `<token>` is a per-process secret
 * bound to the listener. The main process never reads a byte of the file: it
 * grants a path it has already resolved and authorized, and hands back a URL.
 *
 * The worker is started on the first media preview and stops again after a
 * quiet minute, so a session that never plays a video holds no listener and no
 * thread, and one that does stops paying for it once the reader moves on.
 */
/// <reference types="electron-vite/node" />
import { randomBytes } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import createMediaServerWorker from './media-server-worker.ts?nodeWorker'
import { Logger } from '../../system/logger'
import type { MediaServerEvent, MediaServerUpdate } from './media-server-protocol'

/**
 * How long the worker stays up with nothing to serve.
 *
 * Generous on purpose: a reader who pauses a video keeps its URL, and a listener
 * that closes underneath it turns the next range into a failure the player can
 * only recover from with its retry. Five quiet minutes is enough for that to be
 * a real absence rather than a pause.
 */
const IDLE_STOP_MS = 300_000
/**
 * How long a worker may take to come up, or to confirm a grant.
 *
 * Both are bounded because the caller is answering a media request: a worker
 * that never reports in must cost the reader one slow preview and then fall back
 * to the streamed response, never a request that hangs until the player gives up.
 */
const WORKER_READY_TIMEOUT_MS = 2_000
const GRANT_ACK_TIMEOUT_MS = 2_000
/**
 * Grants remembered by path, so a scrub back through a video reuses one URL
 * instead of minting another. Past this the oldest is forgotten here; the
 * worker keeps its copy, because a stream that is still running must not lose
 * its grant when a different file is opened.
 */
const MAX_CACHED_GRANTS = 512

/** One file the caller has already resolved and wants streamed. */
export interface MediaServeTarget {
  /** Absolute path, authorized by the caller's own resolution rules. */
  path: string
  /** Extension with its dot, from the preview type. */
  extension: string
  mime: string
}

interface WorkerHandshake {
  port: number
  token: string
}

export class MediaServer {
  private worker?: Worker
  private handshake?: Promise<WorkerHandshake>
  private readonly ids = new Map<string, string>()
  private activeStreams = 0
  /** Grants posted to the worker, waiting for it to confirm it holds them. */
  private readonly grantWaiters = new Map<string, () => void>()
  private idleTimer?: ReturnType<typeof setTimeout>

  /**
   * A loopback URL for this file, or null when the worker cannot be started.
   *
   * Null is a fallback signal, not an error: the protocol then serves the file
   * the way it always did, so a media server that fails never turns a preview
   * into a missing file.
   */
  async urlFor(target: MediaServeTarget): Promise<string | null> {
    const key = `${target.path}\u0000${target.mime}`
    try {
      const handshake = await this.ensureWorker()
      const known = this.ids.get(key)
      const id = known ?? (await this.grant(target))
      this.ids.set(key, id)
      if (this.ids.size > MAX_CACHED_GRANTS) {
        const oldest = this.ids.keys().next().value
        if (oldest !== undefined && oldest !== key) this.ids.delete(oldest)
      }
      return `http://127.0.0.1:${handshake.port}/media/${id}?token=${handshake.token}`
    } catch {
      this.stop()
      return null
    }
  }

  /** Release the worker and its listener. */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.handshake = undefined
    this.ids.clear()
    this.activeStreams = 0
    this.grantWaiters.clear()
    const worker = this.worker
    this.worker = undefined
    if (!worker) return
    this.post(worker, { type: 'stop' })
    // The worker closes its server and its port first; terminating is the
    // backstop for a worker that is wedged.
    setTimeout(() => void worker.terminate().catch(() => undefined), 1_000).unref?.()
  }

  /**
   * Mint a grant and wait for the worker to hold it.
   *
   * The URL is handed to a media element the moment this resolves, so the grant
   * has to be readable before then: a request that beats the grant answers 404
   * and the reader sees "This video could not be played" for a file that is
   * right there.
   */
  private async grant(target: MediaServeTarget): Promise<string> {
    const worker = this.worker
    if (!worker) throw new Error('The media server is not running.')
    const id = randomBytes(16).toString('hex')
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.grantWaiters.delete(id)
        reject(new Error('The media server did not confirm the file in time.'))
      }, GRANT_ACK_TIMEOUT_MS)
      timer.unref?.()
      this.grantWaiters.set(id, () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.post(worker, {
      type: 'grant',
      grant: { id, path: target.path, extension: target.extension, mime: target.mime }
    })
    await acknowledged
    return id
  }

  private post(worker: Worker, update: MediaServerUpdate): void {
    try {
      worker.postMessage(update)
    } catch {
      // A worker that has already gone away is the caller's signal to fall back.
    }
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      // A video that is buffered ahead can sit without a request for a while; it
      // is still reading, so the listener has to outlive the quiet.
      if (this.activeStreams > 0) {
        this.touchIdle()
        return
      }
      this.stop()
    }, IDLE_STOP_MS)
    this.idleTimer.unref?.()
  }

  private ensureWorker(): Promise<WorkerHandshake> {
    if (this.handshake) {
      this.touchIdle()
      return this.handshake
    }
    const token = randomBytes(24).toString('hex')
    const worker = createMediaServerWorker({
      workerData: { token },
      resourceLimits: { maxOldGenerationSizeMb: 64 }
    })
    this.worker = worker
    const handshake = new Promise<WorkerHandshake>((resolve, reject) => {
      const readyTimer = setTimeout(
        () => fail(new Error('The media server did not start in time.')),
        WORKER_READY_TIMEOUT_MS
      )
      readyTimer.unref?.()
      const fail = (error: Error): void => {
        clearTimeout(readyTimer)
        if (this.worker === worker) this.stop()
        reject(error)
      }
      worker.on('message', (event: MediaServerEvent) => {
        if (this.worker !== worker) return
        if (event.type === 'ready') {
          if (readyTimer) clearTimeout(readyTimer)
          this.touchIdle()
          resolve({ port: event.port, token })
          return
        }
        if (event.type === 'granted') {
          this.grantWaiters.get(event.id)?.()
          this.grantWaiters.delete(event.id)
          return
        }
        if (event.type === 'failed') {
          // A worker that cannot serve is a fallback, not a broken preview: the
          // protocol streams the file itself once this rejects or stops.
          Logger.error('Media server worker reported a problem:', event.message)
          fail(new Error(event.message))
          return
        }
        if (event.type === 'served') this.touchIdle()
        if (event.type === 'busy') {
          this.activeStreams = event.active
          this.touchIdle()
        }
      })
      worker.on('error', (error: unknown) =>
        fail(error instanceof Error ? error : new Error(String(error)))
      )
      worker.on('exit', () => fail(new Error('The media server worker exited')))
    })
    this.handshake = handshake
    handshake.catch(() => {
      if (this.handshake === handshake) this.handshake = undefined
    })
    return handshake
  }
}
