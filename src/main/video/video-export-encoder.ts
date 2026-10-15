/**
 * The encode step of a video export, which runs inside the export renderer.
 *
 * Export used to hand every frame to the main process: `capturePage` delivered a
 * full-frame bitmap and `toBitmap` copied it before the pipe write, so a 4K export
 * moved tens of megabytes per frame through the process that also serves the whole
 * window. Here the renderer encodes H.264 itself with WebCodecs and hands back only
 * compressed chunks, so main sees tens of kilobytes per frame instead.
 *
 * This is the source for script injected into the export window (see
 * `video-export.ts`), so it is written as a self-contained function that is
 * serialized with `toString()` and may not reference module scope.
 */

/** Global the injected script publishes its API on. */
export const VIDEO_EXPORT_ENCODER_GLOBAL = 'cioExportEncoder'

/** What `supported` answers: whether the renderer can encode this export. */
export interface VideoExportEncoderSupport {
  ok: boolean
  reason?: string
  codec?: string
}

/** One frame's worth of encoded bytes, base64, plus any encoder failure. */
export interface VideoExportEncoderDrain {
  chunks: string[]
  error?: string
}

function installVideoExportEncoder(): void {
  // Kept as a literal, not the module constant: this function is serialized with
  // `toString()` and runs where no module scope exists. It must match
  // VIDEO_EXPORT_ENCODER_GLOBAL.
  const encoderGlobal = 'cioExportEncoder'
  const encoderState = {
    encoder: null as VideoEncoder | null,
    source: null as HTMLCanvasElement | null,
    output: null as HTMLCanvasElement | null,
    context: null as CanvasRenderingContext2D | null,
    width: 0,
    height: 0,
    fps: 30,
    acceleration: 'no-preference' as HardwareAcceleration,
    index: 0,
    chunks: [] as Uint8Array[],
    failure: ''
  }

  /** Base64 in bounded slices: a spread over a whole 200 KB chunk overflows the stack. */
  function toBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 32768)
      binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
    return btoa(binary)
  }

  function drain(): { chunks: string[]; error?: string } {
    const chunks = encoderState.chunks.map((bytes) => toBase64(bytes))
    encoderState.chunks.length = 0
    return encoderState.failure ? { chunks, error: encoderState.failure } : { chunks }
  }

  /**
   * The composition's output canvas.
   *
   * An explicit `CIOVideo.useCanvas(canvas)` wins. Otherwise the canvas must be
   * attached, rendered (so a scratch or detached canvas cannot be mistaken for the
   * picture in the video) and share the composition's aspect ratio, and it must be
   * the only such canvas: an ambiguous page falls back to the capture path rather
   * than encoding the wrong element.
   */
  function pickCanvas(width: number, height: number): HTMLCanvasElement | null {
    const explicit = (globalThis as { cioVideoCanvas?: unknown }).cioVideoCanvas
    if (
      typeof HTMLCanvasElement !== 'undefined' &&
      explicit instanceof HTMLCanvasElement &&
      explicit.width > 0 &&
      explicit.height > 0
    )
      return explicit
    const ratio = width / height
    const candidates = Array.from(document.querySelectorAll('canvas')).filter(
      (canvas) =>
        canvas.width > 0 &&
        canvas.height > 0 &&
        canvas.isConnected &&
        canvas.offsetWidth > 0 &&
        canvas.offsetHeight > 0 &&
        Math.abs(canvas.width / canvas.height / ratio - 1) < 0.02
    )
    candidates.sort((left, right) => right.width * right.height - left.width * left.height)
    return candidates.length === 1 ? candidates[0] : null
  }

  /** Widest H.264 configuration first, so a 1080p export is not capped at baseline. */
  function codecLadder(width: number, height: number): string[] {
    const pixels = width * height
    const high =
      pixels <= 1920 * 1088
        ? 'avc1.640028'
        : pixels <= 2560 * 1440
          ? 'avc1.640032'
          : pixels <= 3840 * 2160
            ? 'avc1.640033'
            : 'avc1.640034'
    return [high, 'avc1.4d0033', 'avc1.42e033']
  }

  async function supported(config: {
    width: number
    height: number
    fps: number
  }): Promise<{ ok: boolean; reason?: string; codec?: string }> {
    const canvas = pickCanvas(config.width, config.height)
    if (!canvas) return { ok: false, reason: 'no single full-frame composition canvas' }
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined')
      return { ok: false, reason: 'WebCodecs is unavailable' }
    const bitrate = Math.min(
      48_000_000,
      Math.max(2_500_000, Math.round(config.width * config.height * config.fps * 0.09))
    )
    for (const acceleration of ['prefer-hardware', 'no-preference'] as const)
      for (const codec of codecLadder(config.width, config.height)) {
        const options: VideoEncoderConfig = {
          codec,
          width: config.width,
          height: config.height,
          framerate: config.fps,
          bitrate,
          latencyMode: 'quality',
          hardwareAcceleration: acceleration,
          avc: { format: 'annexb' }
        }
        let support: VideoEncoderSupport
        try {
          support = await VideoEncoder.isConfigSupported(options)
        } catch {
          continue
        }
        // The bundled encoder reads a raw H.264 elementary stream, so an annex-b
        // configuration is required: an AVCC configuration cannot be piped into it.
        if (!support.supported || support.config?.avc?.format !== 'annexb') continue
        const encoder = new VideoEncoder({
          output: (chunk) => {
            const bytes = new Uint8Array(chunk.byteLength)
            chunk.copyTo(bytes)
            encoderState.chunks.push(bytes)
          },
          error: (error) => {
            encoderState.failure = String((error as Error | undefined)?.message ?? error)
          }
        })
        encoder.configure(options)
        encoderState.encoder = encoder
        encoderState.source = canvas
        encoderState.width = config.width
        encoderState.height = config.height
        encoderState.fps = config.fps
        encoderState.index = 0
        encoderState.acceleration = acceleration
        // Encoding happens at the composition's own size, never at the canvas backing
        // size, so a device-pixel-ratio-scaled canvas still yields the authored frame.
        if (canvas.width === config.width && canvas.height === config.height)
          encoderState.output = canvas
        else {
          const output = document.createElement('canvas')
          output.width = config.width
          output.height = config.height
          const context = output.getContext('2d')
          if (!context) throw new Error('Cannot draw the composition frame')
          encoderState.output = output
          encoderState.context = context
        }
        return { ok: true, codec }
      }
    return { ok: false, reason: 'no H.264 encoder configuration is available' }
  }

  /** Draw one composition frame, encode it, and return everything encoded since the last drain. */
  async function frame(seconds: number): Promise<{ chunks: string[]; error?: string }> {
    const host = globalThis as { cioRenderFrame?: (seconds: number) => Promise<void> }
    if (typeof host.cioRenderFrame !== 'function') throw new Error('No cioRenderFrame function')
    await host.cioRenderFrame(seconds)
    const encoder = encoderState.encoder
    const output = encoderState.output
    const source = encoderState.source
    if (!encoder || !output || !source) return drain()
    if (encoderState.failure) return drain()
    if (output !== source && encoderState.context)
      encoderState.context.drawImage(source, 0, 0, encoderState.width, encoderState.height)
    const videoFrame = new VideoFrame(output, {
      timestamp: Math.round(seconds * 1_000_000),
      duration: Math.round(1_000_000 / encoderState.fps)
    })
    encoder.encode(videoFrame, {
      keyFrame: encoderState.index % Math.max(1, Math.round(encoderState.fps * 2)) === 0
    })
    videoFrame.close()
    encoderState.index += 1
    return drain()
  }

  /** Flush the encoder and return the tail of the stream. */
  async function finish(): Promise<{ chunks: string[]; error?: string }> {
    let error = encoderState.failure
    try {
      await encoderState.encoder?.flush()
    } catch (cause) {
      if (!error) error = String((cause as Error | undefined)?.message ?? cause)
    }
    try {
      encoderState.encoder?.close()
    } catch {
      // Closing an encoder that already errored is not itself a failure.
    }
    const result = drain()
    return error && !result.error ? { chunks: result.chunks, error } : result
  }

  ;(globalThis as unknown as Record<string, unknown>)[encoderGlobal] = {
    supported,
    frame,
    finish
  }
}

/** Serialized into the export renderer as its first frame-work script. */
export function videoExportEncoderSource(): string {
  return `(${installVideoExportEncoder.toString()})();\n`
}
