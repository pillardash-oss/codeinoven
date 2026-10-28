import type { VideoCaption, VideoStudioDocument, VideoValue } from '../../lib/video/studio'
import { FONT_STACKS } from '../../lib/app-fonts'
import {
  VIDEO_CAPTION_APPEARANCE,
  type VideoCaptionAppearance,
  type VideoEditorSelection
} from '../../lib/video/edit'
import { createVideoEditRenderer } from './video-edit-runtime'

/** Authored compositions opt into this small runtime; nothing is drawn automatically. */
function installVideoRuntime(
  editorFactory: typeof createVideoEditRenderer,
  fonts: Record<string, string>,
  defaultAppearance: VideoCaptionAppearance
): void {
  const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value))
  let studio: VideoStudioDocument = {
    version: 1,
    controls: [],
    captions: [],
    audioTracks: [],
    captionStyle: 'plain'
  }
  const parameters: Record<string, VideoValue> = Object.create(null)
  const editor = editorFactory({
    seekMedia,
    mediaReady,
    drawCaptions,
    captionBounds,
    captionAppearance
  })
  let currentDraw: ((seconds: number) => Promise<void>) | undefined
  const ready = (async () => {
    await new Promise<void>((resolve) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = './assets/cio-fonts/fonts.css'
      link.onload = () => resolve()
      link.onerror = () => resolve()
      document.head.append(link)
    })
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
  /**
   * The curves a film reaches for, named by what they do rather than by their maths.
   *
   * One curve is not enough to cut a film with: an entrance wants to arrive, a pop
   * wants to overshoot, a shape crossing the frame wants the same easing in and out.
   * Without a set, the author writes the same three functions inside every
   * composition, which is what compositions did before these existed. `ease` stays
   * exactly the cubic out it always was, so a film authored against it is unchanged.
   */
  const easings = {
    linear: (progress: number): number => clamp(progress),
    inCubic: (progress: number): number => Math.pow(clamp(progress), 3),
    outCubic: ease,
    inOutCubic: (progress: number): number => {
      const p = clamp(progress)
      return p < 0.5 ? 4 * Math.pow(p, 3) : 1 - Math.pow(-2 * p + 2, 3) / 2
    },
    inQuint: (progress: number): number => Math.pow(clamp(progress), 5),
    outQuint: (progress: number): number => 1 - Math.pow(1 - clamp(progress), 5),
    inExpo: (progress: number): number => {
      const p = clamp(progress)
      return p === 0 ? 0 : Math.pow(2, 10 * p - 10)
    },
    outExpo: (progress: number): number => {
      const p = clamp(progress)
      return p === 1 ? 1 : 1 - Math.pow(2, -10 * p)
    },
    inOutExpo: (progress: number): number => {
      const p = clamp(progress)
      if (p === 0 || p === 1) return p
      return p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2
    },
    outBack: (progress: number): number => {
      const p = clamp(progress),
        overshoot = 1.70158,
        scaled = overshoot + 1
      return 1 + scaled * Math.pow(p - 1, 3) + overshoot * Math.pow(p - 1, 2)
    }
  }
  function captionAppearance(index: number): VideoCaptionAppearance {
    return {
      ...defaultAppearance,
      ...studio.captionAppearance,
      ...studio.captions[index]?.appearance
    }
  }
  function captionLayout(
    ctx: CanvasRenderingContext2D,
    caption: VideoCaption,
    width: number,
    height: number
  ) {
    const appearance = { ...defaultAppearance, ...studio.captionAppearance, ...caption.appearance }
    ctx.font = `${appearance.weight} ${height * appearance.size}px ${fonts[appearance.font] ?? fonts.system}`
    const words = caption.words?.length
      ? caption.words
      : caption.text.split(/\s+/u).map((text) => ({ text, start: caption.start, end: caption.end }))
    const lines: (typeof words)[] = [[]]
    let currentWidth = 0
    const gap = ctx.measureText(' ').width
    for (const word of words) {
      const wordWidth = ctx.measureText(word.text).width
      if (currentWidth + wordWidth > width * appearance.width && lines[lines.length - 1].length) {
        lines.push([])
        currentWidth = 0
      }
      lines[lines.length - 1].push(word)
      currentWidth += wordWidth + gap
    }
    const lineHeight = height * appearance.size * 1.4
    const top = height * appearance.y - (lines.length - 1) * lineHeight
    return { appearance, lines, lineHeight, top, gap }
  }
  function captionBounds(index: number, width: number, height: number) {
    const output = (window as typeof window & { cioVideoCanvas?: HTMLCanvasElement }).cioVideoCanvas
    const ctx = output?.getContext('2d'),
      caption = studio.captions[index]
    if (!ctx || !caption) return null
    ctx.save()
    const { appearance, lines, lineHeight, top } = captionLayout(ctx, caption, width, height)
    ctx.restore()
    return {
      x: appearance.x - appearance.width / 2,
      y: (top - lineHeight * 0.7) / height,
      width: appearance.width,
      height: ((lines.length + 0.4) * lineHeight) / height
    }
  }
  function drawCaptions(
    ctx: CanvasRenderingContext2D,
    seconds: number,
    width: number,
    height: number
  ): void {
    // A composition can carry its words and still show none of them, which is a
    // choice the user makes in the editor rather than a missing transcript.
    if (studio.captionStyle === 'none') return
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
    if (!caption || studio.edit?.tracks.find((track) => track.id === caption.trackId)?.hidden)
      return
    ctx.save()
    const { appearance, lines, lineHeight, top, gap } = captionLayout(ctx, caption, width, height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = appearance.background
    ctx.globalAlpha = appearance.backgroundOpacity
    ctx.fillRect(
      width * (appearance.x - appearance.width / 2),
      top - lineHeight * 0.7,
      width * appearance.width,
      lines.length * lineHeight + lineHeight * 0.4
    )
    ctx.globalAlpha = 1
    lines.forEach((line, row) => {
      const total =
        line.reduce((sum, word) => sum + ctx.measureText(word.text).width, 0) +
        (line.length - 1) * gap
      let x = width * appearance.x - total / 2
      for (const word of line) {
        const measured = ctx.measureText(word.text).width
        const active = seconds >= word.start && seconds < word.end
        const spoken = seconds >= word.end
        // The three styles have to be tellable apart at a glance, because the
        // picker asks the user to choose between them and a preview that draws
        // them the same is asking them to choose blind. Plain is one colour;
        // highlight paints the word being spoken; karaoke fills the words in as
        // they pass, so what is said next still reads while it is dimmer.
        ctx.save()
        ctx.translate(x + measured / 2, top + row * lineHeight)
        if (studio.captionStyle === 'highlight' && active) {
          const pad = lineHeight * 0.2
          ctx.fillStyle = '#facc15'
          ctx.fillRect(
            -(measured / 2) - pad,
            -(lineHeight * 0.42),
            measured + pad * 2,
            lineHeight * 0.84
          )
          ctx.fillStyle = '#111111'
          ctx.fillText(word.text, 0, 0, width * 0.8)
        } else if (studio.captionStyle === 'karaoke') {
          ctx.fillStyle = spoken || active ? '#facc15' : 'rgba(255,255,255,0.4)'
          if (active) ctx.scale(1.12, 1.12)
          ctx.fillText(word.text, 0, 0, width * 0.8)
        } else {
          ctx.fillStyle = appearance.color
          ctx.fillText(word.text, 0, 0, width * 0.8)
        }
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
  /**
   * How far a running element may sit from the asked second before it is seeked.
   *
   * A viewing asks for a new second every frame, and an exact seek costs a decode
   * from the previous keyframe: on a 1080p H.264 source that is a tenth of a
   * second per frame, so asking for an exact position thirty times a second is
   * what makes a composition skip. Within one frame of the target the picture the
   * element is already decoding *is* the right picture, so a playing element is
   * left alone. A paused one (a still, a scrub, an export step) is still placed
   * exactly, and so is a running one that has drifted a whole frame away.
   */
  const PLAYBACK_SEEK_TOLERANCE = 0.05
  async function seekMedia(media: HTMLMediaElement, seconds: number): Promise<void> {
    const target = clamp(
      // Chromium can round an exact video PTS down to the preceding sample.
      // Seek just inside the requested frame while keeping composition time exact.
      seconds + (media instanceof HTMLVideoElement && media.paused ? 0.0001 : 0),
      0,
      Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.001) : seconds
    )
    const tolerance = media.paused ? 0.001 : PLAYBACK_SEEK_TOLERANCE
    if (Math.abs(media.currentTime - target) < tolerance && media.readyState >= 2) return
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
    easings,
    drawCaptions,
    strokePath,
    polygon,
    morphPath,
    pivot,
    trackingAt,
    seekMedia,
    mediaReady,
    async setStudio(next: VideoStudioDocument, selection: VideoEditorSelection): Promise<void> {
      await ready
      studio = next
      for (const key of Object.keys(parameters)) delete parameters[key]
      for (const control of studio.controls) parameters[control.key] = control.value
      editor.setSelection(selection)
      const host = window as typeof window & {
        cioVideoCanvas?: HTMLCanvasElement
        __cioTransport?: {
          time: number
          playing: boolean
          setDuration?: (seconds: number) => void
          freezeAt?: (seconds: number) => Promise<unknown>
        }
      }
      if (studio.edit) host.__cioTransport?.setDuration?.(studio.edit.duration)
      if (studio.edit && host.cioVideoCanvas && !host.__cioTransport?.playing) {
        if (host.__cioTransport?.freezeAt)
          await host.__cioTransport.freezeAt(host.__cioTransport.time)
        else await currentDraw?.(0)
      }
    },
    takeGesture: editor.takeGesture,
    get editing() {
      return editor.editing
    },
    stopEditing: editor.stopEditing,
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
        const tracks = (studio.edit ? [] : studio.audioTracks).map((track) => {
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
      currentDraw = async (seconds) => {
        const tracks = await initializing
        const canvas = (window as typeof window & { cioVideoCanvas?: HTMLCanvasElement })
          .cioVideoCanvas
        if (studio.edit && canvas) {
          for (const { audio } of tracks) audio.pause()
          if (studio.edit.background === 'composition') await draw(seconds)
          await editor.render(studio, canvas, seconds)
          return
        }
        const frozen = new URLSearchParams(location.search).has('cio-capture')
        for (const { track, audio } of tracks) {
          const local = seconds - track.start
          const active = local >= 0 && local < track.duration
          audio.volume = clamp(track.gain)
          const playing = host.__cioTransport?.playing ?? !frozen
          if (!active || frozen || !playing) audio.pause()
          // A running bed is already on the playhead: the app's transport keeps it
          // there, and re-seeking it for a hundredth of a second is what makes a
          // viewing stutter. Only a paused bed (a still, a scrub, an export step)
          // is placed exactly, or one that has drifted far enough to be heard.
          const target = local + track.trim
          if (active && (audio.paused || Math.abs(audio.currentTime - target) > 0.25))
            await seekMedia(audio, target)
          if (active && !frozen && playing && audio.paused) void audio.play().catch(() => undefined)
        }
        await draw(seconds)
      }
      host.cioRenderFrame = currentDraw
      await initializing
      if (!host.__cioTransport)
        await host.cioRenderFrame(Number(new URLSearchParams(location.search).get('cio-time') ?? 0))
    }
  }
  Object.assign(window, { CIOVideo: api })
}

/** Compiles to plain JS before being serialized; no package or network import in authored work. */
export function videoRuntimeSource(): string {
  return `${VIDEO_RUNTIME_MARKER}\n(${installVideoRuntime.toString()})(${createVideoEditRenderer.toString()},${JSON.stringify(FONT_STACKS)},${JSON.stringify(VIDEO_CAPTION_APPEARANCE)});\n`
}

/**
 * First line of every generated runtime.
 *
 * It is what lets an install recognise a copy this app wrote earlier, so a fixed
 * runtime reaches a composition that already has one, while a file someone
 * authored under the same name is still refused rather than overwritten.
 */
export const VIDEO_RUNTIME_MARKER =
  '/* CodeInOven composition runtime. Generated by the app: reinstall it with the runtime operation instead of editing this file. */'
