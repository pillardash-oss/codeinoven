import type { VideoStudioDocument, VideoValue } from '../../lib/video/studio'

/** Authored compositions opt into this small runtime; nothing is drawn automatically. */
function installVideoRuntime(): void {
  const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value))
  let studio: VideoStudioDocument = {
    version: 1,
    controls: [],
    captions: [],
    audioTracks: [],
    captionStyle: 'plain'
  }
  const parameters: Record<string, VideoValue> = Object.create(null)
  const ready = (async () => {
    const response = await fetch('./studio.json', { cache: 'no-store' })
    if (response.status !== 404) {
      if (!response.ok) throw new Error('Cannot read video controls')
      studio = await response.json()
    }
    for (const control of studio.controls) parameters[control.key] = control.value
    if (!studio.audioTracks.length) {
      const manifestResponse = await fetch('./composition.json', { cache: 'no-store' })
      if (!manifestResponse.ok) throw new Error('Cannot read composition audio')
      const manifest = await manifestResponse.json()
      studio.audioTracks = (manifest.audio ?? []).map((source: string) => ({
        source,
        start: 0,
        trim: 0,
        duration: manifest.duration,
        gain: 1
      }))
    }
  })()
  // `ready` starts eagerly, so a composition that never awaits it still has its
  // saved parameters by the time it draws. Nothing holds it yet, though, so a
  // failed fetch (a missing or malformed studio.json) would reach the page as an
  // unhandled rejection before `bind` or `CIOVideo.ready` ever observes it. This
  // marks that rejection handled without changing what either of them sees.
  void ready.catch(() => undefined)
  const progress = (seconds: number, start: number, duration: number): number =>
    clamp((seconds - start) / Math.max(0.001, duration))
  const interpolate = (from: number, to: number, progress: number): number =>
    from + (to - from) * clamp(progress)
  const ease = (progress: number): number => 1 - Math.pow(1 - clamp(progress), 3)
  function drawCaptions(
    ctx: CanvasRenderingContext2D,
    seconds: number,
    width: number,
    height: number
  ): void {
    let low = 0,
      high = studio.captions.length - 1
    let caption: VideoStudioDocument['captions'][number] | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2),
        candidate = studio.captions[middle]
      if (seconds < candidate.start) high = middle - 1
      else if (seconds >= candidate.end) low = middle + 1
      else {
        caption = candidate
        break
      }
    }
    if (!caption) return
    ctx.save()
    ctx.font = `600 ${height * 0.035}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const words = caption.words?.length
      ? caption.words
      : [{ text: caption.text, start: caption.start, end: caption.end }]
    const lines: (typeof words)[] = [[]]
    let currentWidth = 0
    const gap = ctx.measureText(' ').width
    for (const word of words) {
      const wordWidth = ctx.measureText(word.text).width
      if (currentWidth + wordWidth > width * 0.82 && lines[lines.length - 1].length) {
        lines.push([])
        currentWidth = 0
      }
      lines[lines.length - 1].push(word)
      currentWidth += wordWidth + gap
    }
    const lineHeight = height * 0.05
    const top = height * 0.87 - (lines.length - 1) * lineHeight
    ctx.fillStyle = 'rgba(0,0,0,0.8)'
    ctx.fillRect(
      width * 0.07,
      top - lineHeight * 0.7,
      width * 0.86,
      lines.length * lineHeight + lineHeight * 0.4
    )
    lines.forEach((line, row) => {
      const total =
        line.reduce((sum, word) => sum + ctx.measureText(word.text).width, 0) +
        (line.length - 1) * gap
      let x = (width - total) / 2
      for (const word of line) {
        const measured = ctx.measureText(word.text).width
        const active = seconds >= word.start && seconds < word.end
        ctx.fillStyle = studio.captionStyle !== 'plain' && active ? '#facc15' : '#ffffff'
        ctx.save()
        ctx.translate(x + measured / 2, top + row * lineHeight)
        if (studio.captionStyle === 'karaoke' && active) ctx.scale(1.08, 1.08)
        ctx.fillText(word.text, 0, 0, width * 0.8)
        ctx.restore()
        x += measured + gap
      }
    })
    ctx.restore()
  }
  const paths = new Map<string, Path2D>()
  function strokePath(
    ctx: CanvasRenderingContext2D,
    d: string,
    length: number,
    reveal: number,
    options: {
      dash?: number[]
      offset?: number
      cap?: CanvasLineCap
      paint?: string | CanvasGradient
    } = {}
  ): void {
    ctx.save()
    ctx.lineCap = options.cap ?? 'round'
    if (options.paint) ctx.strokeStyle = options.paint
    ctx.setLineDash(options.dash ?? [Math.max(0.001, length * clamp(reveal)), length])
    ctx.lineDashOffset = options.offset ?? 0
    let path = paths.get(d)
    if (!path) {
      if (paths.size >= 64) paths.delete(paths.keys().next().value!)
      path = new Path2D(d)
      paths.set(d, path)
    }
    ctx.stroke(path)
    ctx.restore()
  }
  function polygon(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    count: number,
    angle = 0
  ): void {
    const points = Math.max(3, Math.min(64, Math.round(count)))
    ctx.beginPath()
    for (let index = 0; index < points; index += 1) {
      const direction = angle + (index * Math.PI * 2) / points
      const px = x + Math.cos(direction) * radius,
        py = y + Math.sin(direction) * radius
      if (index === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
  }
  function morphPath(from: string, to: string, amount: number): string {
    const number = /-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/giu
    if (from.replace(number, '#') !== to.replace(number, '#'))
      throw new Error('Path morphs require matching commands')
    const targets = to.match(number)?.map(Number) ?? []
    let index = 0
    return from.replace(number, (value) =>
      String(interpolate(Number(value), targets[index++], amount))
    )
  }
  function pivot(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    scale = 1
  ): void {
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.scale(scale, scale)
    ctx.translate(-x, -y)
  }
  function trackingAt(
    points: { time: number; x: number; y: number; confidence: number }[],
    seconds: number
  ): { x: number; y: number; confidence: number } | null {
    if (!points.length) return null
    let left = points[0],
      right = points[points.length - 1]
    for (let index = 1; index < points.length; index += 1) {
      if (points[index].time >= seconds) {
        left = points[index - 1]
        right = points[index]
        break
      }
      left = points[index]
    }
    const p = right.time === left.time ? 0 : clamp((seconds - left.time) / (right.time - left.time))
    return {
      x: interpolate(left.x, right.x, p),
      y: interpolate(left.y, right.y, p),
      confidence: Math.min(left.confidence, right.confidence)
    }
  }
  async function seekMedia(media: HTMLMediaElement, seconds: number): Promise<void> {
    const target = clamp(
      seconds,
      0,
      Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.001) : seconds
    )
    if (Math.abs(media.currentTime - target) < 0.001 && media.readyState >= 2) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Media seek timed out')), 10000)
      function finish(error?: Error): void {
        clearTimeout(timer)
        media.removeEventListener('seeked', done)
        media.removeEventListener('error', fail)
        if (error) reject(error)
        else resolve()
      }
      const done = (): void => finish()
      const fail = (): void => finish(new Error('Cannot decode media'))
      media.addEventListener('seeked', done, { once: true })
      media.addEventListener('error', fail, { once: true })
      media.currentTime = target
    })
  }
  async function mediaReady(media: HTMLMediaElement): Promise<void> {
    if (media.readyState >= 2) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Media loading timed out')), 10000)
      function finish(error?: Error): void {
        clearTimeout(timeout)
        media.removeEventListener('loadeddata', done)
        media.removeEventListener('error', fail)
        if (error) reject(error)
        else resolve()
      }
      const done = (): void => finish()
      const fail = (): void => finish(new Error('Cannot load media'))
      media.addEventListener('loadeddata', done, { once: true })
      media.addEventListener('error', fail, { once: true })
      media.load()
    })
  }
  const api = {
    ready,
    parameters,
    progress,
    interpolate,
    ease,
    drawCaptions,
    strokePath,
    polygon,
    morphPath,
    pivot,
    trackingAt,
    seekMedia,
    mediaReady,
    /**
     * Name the canvas the export should encode.
     *
     * The export encodes this canvas in the renderer, which keeps full-frame
     * bitmaps out of the main process. Without it the export has to guess from the
     * document, and falls back to capturing the window frame by frame when the
     * guess is not unambiguous, so calling this is what makes an export cheap.
     */
    useCanvas(canvas: HTMLCanvasElement): void {
      ;(window as typeof window & { cioVideoCanvas?: HTMLCanvasElement }).cioVideoCanvas = canvas
    },
    async bind(draw: (seconds: number) => void | Promise<void>): Promise<void> {
      const initializing = (async () => {
        await ready
        await document.fonts.ready
        const tracks = studio.audioTracks.map((track) => {
          const audio = new Audio(track.source)
          audio.dataset.cioTrackStart = String(track.start)
          audio.dataset.cioTrackTrim = String(track.trim)
          audio.dataset.cioTrackDuration = String(track.duration)
          return { track, audio }
        })
        await Promise.all(tracks.map(({ audio }) => mediaReady(audio)))
        return tracks
      })()
      const host = window as typeof window & {
        cioRenderFrame?: (seconds: number) => Promise<void>
        __cioTransport?: { playing: boolean }
      }
      host.cioRenderFrame = async (seconds) => {
        const tracks = await initializing
        const frozen = new URLSearchParams(location.search).has('cio-capture')
        for (const { track, audio } of tracks) {
          const local = seconds - track.start
          const active = local >= 0 && local < track.duration
          audio.volume = clamp(track.gain)
          const playing = host.__cioTransport?.playing ?? !frozen
          if (!active || frozen || !playing) audio.pause()
          if (active && Math.abs(audio.currentTime - (local + track.trim)) > 0.1)
            await seekMedia(audio, local + track.trim)
          if (active && !frozen && playing && audio.paused) void audio.play().catch(() => undefined)
        }
        await draw(seconds)
      }
      await initializing
      if (!host.__cioTransport)
        await host.cioRenderFrame(Number(new URLSearchParams(location.search).get('cio-time') ?? 0))
    }
  }
  Object.assign(window, { CIOVideo: api })
}

/** Compiles to plain JS before being serialized; no package or network import in authored work. */
export function videoRuntimeSource(): string {
  return `(${installVideoRuntime.toString()})();\n`
}
