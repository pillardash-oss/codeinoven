import type { DisplayInputKey } from '$shared/ipc/display'
import {
  isStreamOutbound,
  type StreamChunkMessage,
  type StreamConfigMessage,
  type StreamInbound,
  type StreamPointerAction
} from '$shared/display-stream-protocol'

/**
 * The renderer end of a live device stream.
 *
 * Encoded H.264 arrives on a `MessagePort` straight from the stream's utility
 * process and is decoded by the browser's hardware `VideoDecoder`, then painted to a
 * canvas. Pointer and key events travel back on the same port as they happen.
 *
 * Latency beats completeness here: only the newest decoded frame is ever kept, one
 * frame is painted per animation frame, and a decoder that falls behind drops
 * delta frames until the next key frame instead of building a queue.
 */

/** A decoder with more than this many chunks waiting is behind and sheds load. */
const MAX_DECODE_QUEUE = 3

/** What the touch controller needs from a stream, so it never imports the decoder. */
export interface StreamInput {
  pointer: (action: StreamPointerAction, x: number, y: number) => void
  movePointer: (x: number, y: number) => void
  key: (key: DisplayInputKey) => void
  text: (text: string) => void
  scroll: (x: number, y: number, dx: number, dy: number) => void
}

export class DisplayStream implements StreamInput {
  /** The picture's size in device pixels, 0 until the first config arrives. */
  width = $state(0)
  height = $state(0)

  private decoder: VideoDecoder | null = null
  private latest: VideoFrame | null = null
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private paintHandle = 0
  private moveHandle = 0
  private pendingMove: { x: number; y: number } | null = null
  private needKey = true
  private finished = false

  constructor(
    private readonly port: MessagePort,
    private readonly onEnded: (detail: string | null) => void
  ) {
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data)
    port.start()
  }

  /** Attachment: paint into this canvas for as long as it is mounted. */
  attach = (canvas: HTMLCanvasElement): (() => void) => {
    this.canvas = canvas
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true })
    this.schedulePaint()
    return () => {
      if (this.canvas === canvas) {
        this.canvas = null
        this.context = null
      }
    }
  }

  pointer(action: StreamPointerAction, x: number, y: number): void {
    // A move still waiting for its frame goes first, so the device sees the finger
    // arrive where it lifted.
    this.flushMove()
    this.post({ type: 'pointer', action, x, y })
  }

  /** Remember the newest position; one move per animation frame goes out. */
  movePointer(x: number, y: number): void {
    this.pendingMove = { x, y }
    if (this.moveHandle === 0) {
      this.moveHandle = requestAnimationFrame(() => {
        this.moveHandle = 0
        this.flushMove()
      })
    }
  }

  key(key: DisplayInputKey): void {
    this.post({ type: 'key', key })
  }

  text(text: string): void {
    this.post({ type: 'text', text })
  }

  scroll(x: number, y: number, dx: number, dy: number): void {
    this.post({ type: 'scroll', x, y, dx, dy })
  }

  /** Release the decoder, the held frame and the port. Safe to call twice. */
  dispose(): void {
    this.finished = true
    if (this.paintHandle !== 0) cancelAnimationFrame(this.paintHandle)
    if (this.moveHandle !== 0) cancelAnimationFrame(this.moveHandle)
    this.paintHandle = 0
    this.moveHandle = 0
    this.pendingMove = null
    this.port.onmessage = null
    this.port.close()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
    this.latest?.close()
    this.latest = null
  }

  private flushMove(): void {
    const move = this.pendingMove
    if (!move) return
    this.pendingMove = null
    this.post({ type: 'pointer', action: 'move', x: move.x, y: move.y })
  }

  private post(message: StreamInbound): void {
    if (!this.finished) this.port.postMessage(message)
  }

  private receive(data: unknown): void {
    if (this.finished || !isStreamOutbound(data)) return
    if (data.type === 'config') this.configure(data)
    else if (data.type === 'chunk') this.decode(data)
    else if (data.phase === 'ended') this.end(data.detail ?? null)
  }

  private configure(config: StreamConfigMessage): void {
    this.width = config.width
    this.height = config.height
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    const decoder = new VideoDecoder({
      output: (frame) => {
        this.latest?.close()
        this.latest = frame
        this.schedulePaint()
      },
      error: (error) => this.fail(error.message)
    })
    try {
      decoder.configure({
        codec: config.codec,
        codedWidth: config.width,
        codedHeight: config.height,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware'
      })
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }
    this.decoder = decoder
    this.needKey = true
  }

  private decode(chunk: StreamChunkMessage): void {
    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured') return
    if (!chunk.key && decoder.decodeQueueSize > MAX_DECODE_QUEUE) this.needKey = true
    if (this.needKey && !chunk.key) return
    if (chunk.key) this.needKey = false
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: chunk.key ? 'key' : 'delta',
          timestamp: chunk.timestampUs,
          data: chunk.data
        })
      )
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private schedulePaint(): void {
    if (this.paintHandle !== 0 || !this.latest || !this.canvas) return
    this.paintHandle = requestAnimationFrame(() => {
      this.paintHandle = 0
      const frame = this.latest
      const canvas = this.canvas
      const context = this.context
      if (!frame || !canvas || !context) return
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth
        canvas.height = frame.displayHeight
      }
      context.drawImage(frame, 0, 0)
    })
  }

  /** The decoder cannot continue: tell the host to stop so the panel can poll instead. */
  private fail(reason: string): void {
    if (this.finished) return
    this.post({ type: 'abort', reason })
    this.end(reason)
  }

  private end(detail: string | null): void {
    if (this.finished) return
    this.dispose()
    this.onEnded(detail)
  }
}
