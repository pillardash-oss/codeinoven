import type { VideoStudioDocument } from '../../lib/video/studio'
import type {
  VideoEditClip,
  VideoEditRect,
  VideoEditorGesture,
  VideoEditorSelection
} from '../../lib/video/edit'

export interface VideoEditRendererHooks {
  seekMedia(media: HTMLMediaElement, seconds: number): Promise<void>
  mediaReady(media: HTMLMediaElement): Promise<void>
  drawCaptions(ctx: CanvasRenderingContext2D, seconds: number, width: number, height: number): void
}

/** Serialized into the composition. All decoding, filtering and gestures stay in its renderer. */
export function createVideoEditRenderer(hooks: VideoEditRendererHooks) {
  type Media = {
    element: HTMLVideoElement | HTMLAudioElement | HTMLImageElement
    source: string
    used: number
    ready: Promise<void>
  }
  type AudioGraph = {
    input: MediaElementAudioSourceNode
    highpass: BiquadFilterNode
    lowpass: BiquadFilterNode
    direct: GainNode
    low: BiquadFilterNode
    high: BiquadFilterNode
    deesser: DynamicsCompressorNode
    band: GainNode
    compressor: DynamicsCompressorNode
    gain: GainNode
    pan: StereoPannerNode
  }
  const media = new Map<string, Media>()
  let wanted = new Set<string>()
  const graphs = new Map<HTMLMediaElement, AudioGraph>()
  let audioContext: AudioContext | null = null
  let frame = 0
  let selection: VideoEditorSelection = null
  let studio: VideoStudioDocument | null = null
  let canvas: HTMLCanvasElement | null = null
  let overlay: HTMLCanvasElement | null = null
  let observer: ResizeObserver | null = null
  let gestureReceiver: ((gesture: VideoEditorGesture | null) => void) | null = null
  let drag: {
    startX: number
    startY: number
    rect: VideoEditRect
    resize: boolean
    selection: Exclude<VideoEditorSelection, null>
  } | null = null
  let dragRect: VideoEditRect | null = null
  const scratch = document.createElement('canvas')
  const scratchContext = scratch.getContext('2d')
  const gradeFilters = new Map<
    string,
    { filter: SVGFilterElement; matrix: SVGFEColorMatrixElement; used: number; value: number }
  >()
  let filterRoot: SVGSVGElement | null = null
  const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value))
  const host = globalThis as typeof globalThis & {
    __cioTransport?: { playing: boolean; time: number }
    __cioEditPreviewDisabled?: boolean
  }

  function release(entry: Media): void {
    if (entry.element instanceof HTMLMediaElement) {
      entry.element.pause()
      const graph = graphs.get(entry.element)
      if (graph) {
        graph.input.disconnect()
        graph.pan.disconnect()
        graphs.delete(entry.element)
      }
      entry.element.removeAttribute('src')
      entry.element.load()
    } else entry.element.src = ''
  }

  async function load(
    key: string,
    source: string,
    kind: 'video' | 'audio' | 'image'
  ): Promise<Media['element']> {
    let entry = media.get(key)
    if (entry && entry.source !== source) {
      release(entry)
      media.delete(key)
      entry = undefined
    }
    if (!entry) {
      // Bound retained decoder state. Only active or just-used layers remain warm.
      if (media.size >= 16) {
        const oldest = [...media]
          .filter(([key]) => !wanted.has(key))
          .sort((a, b) => a[1].used - b[1].used)[0]
        if (oldest) {
          release(oldest[1])
          media.delete(oldest[0])
        }
      }
      let element: Media['element'], ready: Promise<void>
      if (kind === 'image') {
        const image = new Image()
        ready = new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error(`Cannot load image ${source}`))
        })
        image.src = source
        element = image
      } else {
        const item = document.createElement(kind)
        item.preload = 'auto'
        if (item instanceof HTMLVideoElement) {
          item.muted = true
          item.playsInline = true
        }
        item.src = source
        element = item
        ready = hooks.mediaReady(item)
      }
      entry = { element, source, ready, used: frame }
      media.set(key, entry)
    }
    entry.used = frame
    await entry.ready
    return entry.element
  }

  function graphFor(element: HTMLMediaElement): AudioGraph {
    const existing = graphs.get(element)
    if (existing) return existing
    audioContext ??= new AudioContext()
    const context = audioContext,
      input = context.createMediaElementSource(element)
    const highpass = context.createBiquadFilter(),
      lowpass = context.createBiquadFilter()
    highpass.type = 'highpass'
    lowpass.type = 'lowpass'
    const direct = context.createGain(),
      low = context.createBiquadFilter(),
      high = context.createBiquadFilter()
    low.type = 'lowpass'
    high.type = 'highpass'
    low.frequency.value = 5500
    high.frequency.value = 5500
    const deesser = context.createDynamicsCompressor(),
      band = context.createGain(),
      compressor = context.createDynamicsCompressor()
    const gain = context.createGain(),
      pan = context.createStereoPanner()
    input.connect(highpass)
    highpass.connect(lowpass)
    lowpass.connect(direct)
    direct.connect(compressor)
    lowpass.connect(low)
    low.connect(band)
    lowpass.connect(high)
    high.connect(deesser)
    deesser.connect(band)
    band.connect(compressor)
    compressor.connect(gain)
    gain.connect(pan)
    pan.connect(context.destination)
    const result = {
      input,
      highpass,
      lowpass,
      direct,
      low,
      high,
      deesser,
      band,
      compressor,
      gain,
      pan
    }
    graphs.set(element, result)
    return result
  }

  function audioSettings(element: HTMLMediaElement, clip: VideoEditClip, time: number): void {
    const graph = graphFor(element),
      context = audioContext!
    const settings = clip.audio,
      local = time - clip.start
    graph.highpass.frequency.value = settings.highpass
    graph.lowpass.frequency.value = settings.lowpass
    graph.direct.gain.value = settings.deess > 0 ? 0 : 1
    graph.band.gain.value = settings.deess > 0 ? 1 : 0
    graph.deesser.threshold.value = -12 - settings.deess * 24
    graph.deesser.ratio.value = 1 + settings.deess * 9
    graph.deesser.knee.value = 12
    graph.deesser.attack.value = 0.002
    graph.deesser.release.value = 0.08
    graph.compressor.threshold.value = settings.compression > 0 ? -24 : 0
    graph.compressor.ratio.value = 1 + settings.compression * 7
    graph.compressor.knee.value = 12
    graph.compressor.attack.value = 0.005
    graph.compressor.release.value = 0.1
    const envelope = Math.min(
      clip.fadeIn ? clamp(local / clip.fadeIn) : 1,
      clip.fadeOut ? clamp((clip.duration - local) / clip.fadeOut) : 1
    )
    graph.gain.gain.setTargetAtTime(
      clip.volume * envelope * (1 + settings.compression),
      context.currentTime,
      0.015
    )
    graph.pan.pan.value = settings.pan
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  function temperatureFilter(clip: VideoEditClip): string {
    if (clip.grade.temperature === 0) return ''
    const ns = 'http://www.w3.org/2000/svg'
    if (!filterRoot) {
      filterRoot = document.createElementNS(ns, 'svg')
      filterRoot.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none'
      document.body.append(filterRoot)
    }
    let entry = gradeFilters.get(clip.id)
    if (!entry) {
      if (gradeFilters.size >= 64) {
        const oldest = [...gradeFilters].sort((a, b) => a[1].used - b[1].used)[0]
        if (oldest) {
          oldest[1].filter.remove()
          gradeFilters.delete(oldest[0])
        }
      }
      const filter = document.createElementNS(ns, 'filter'),
        matrix = document.createElementNS(ns, 'feColorMatrix')
      filter.id = `cio-grade-${clip.id}`
      filter.setAttribute('color-interpolation-filters', 'sRGB')
      matrix.setAttribute('type', 'matrix')
      filter.append(matrix)
      filterRoot.append(filter)
      entry = { filter, matrix, used: frame, value: Infinity }
      gradeFilters.set(clip.id, entry)
    }
    entry.used = frame
    if (entry.value !== clip.grade.temperature) {
      const t = clip.grade.temperature
      entry.matrix.setAttribute(
        'values',
        `${1 + t * 0.2} 0 0 0 0 0 1 0 0 0 0 0 ${1 - t * 0.2} 0 0 0 0 0 1 0`
      )
      entry.value = t
    }
    return ` url(#${entry.filter.id})`
  }

  function selectedRect(): VideoEditRect | null {
    if (dragRect) return dragRect
    if (!studio || !selection) return null
    const target = selection
    if (target.kind === 'clip')
      return studio.edit?.clips.find((clip) => clip.id === target.id)?.rect ?? null
    if (target.kind === 'region')
      return studio.edit?.regions.find((region) => region.id === target.id) ?? null
    const appearance = studio.captions[target.index]?.appearance ?? studio.captionAppearance
    return appearance
      ? {
          x: appearance.x - appearance.width / 2,
          y: appearance.y - appearance.size,
          width: appearance.width,
          height: appearance.size * 2
        }
      : { x: 0.08, y: 0.825, width: 0.84, height: 0.07 }
  }

  function paintOverlay(): void {
    if (!overlay || !canvas) return
    if (host.__cioTransport?.playing) {
      overlay.style.display = 'none'
      return
    }
    overlay.style.display = ''
    const bounds = canvas.getBoundingClientRect()
    // object-fit: contain may letterbox the canvas element inside its native view.
    const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height)
    const width = canvas.width * scale,
      height = canvas.height * scale
    overlay.style.left = `${bounds.left + (bounds.width - width) / 2}px`
    overlay.style.top = `${bounds.top + (bounds.height - height) / 2}px`
    overlay.style.width = `${width}px`
    overlay.style.height = `${height}px`
    const pixelWidth = Math.max(1, Math.round(width)),
      pixelHeight = Math.max(1, Math.round(height))
    if (overlay.width !== pixelWidth) overlay.width = pixelWidth
    if (overlay.height !== pixelHeight) overlay.height = pixelHeight
    const ctx = overlay.getContext('2d'),
      rect = selectedRect()
    if (!ctx) return
    ctx.clearRect(0, 0, overlay.width, overlay.height)
    if (!rect) {
      overlay.style.pointerEvents = 'none'
      return
    }
    overlay.style.pointerEvents = 'auto'
    ctx.strokeStyle =
      getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() ||
      '#e7bb42'
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = 2
    const x = rect.x * overlay.width,
      y = rect.y * overlay.height,
      w = rect.width * overlay.width,
      h = rect.height * overlay.height
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
    for (const [px, py] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ])
      ctx.fillRect(px - 4, py - 4, 8, 8)
  }

  function installOverlay(): void {
    if (!canvas || overlay || host.__cioEditPreviewDisabled) return
    overlay = document.createElement('canvas')
    overlay.dataset.cioEditOverlay = ''
    overlay.style.cssText = 'position:fixed;z-index:1;touch-action:none;cursor:move'
    document.body.append(overlay)
    observer = new ResizeObserver(paintOverlay)
    observer.observe(canvas)
    overlay.addEventListener('pointerdown', (event) => {
      const rect = selectedRect()
      if (!overlay || !rect || !selection || host.__cioTransport?.playing) return
      const bounds = overlay.getBoundingClientRect(),
        x = (event.clientX - bounds.left) / bounds.width,
        y = (event.clientY - bounds.top) / bounds.height
      if (
        x < rect.x - 0.02 ||
        x > rect.x + rect.width + 0.02 ||
        y < rect.y - 0.02 ||
        y > rect.y + rect.height + 0.02
      )
        return
      event.preventDefault()
      overlay.setPointerCapture(event.pointerId)
      drag = {
        startX: x,
        startY: y,
        rect: { ...rect },
        resize:
          Math.abs(x - rect.x - rect.width) < 0.04 && Math.abs(y - rect.y - rect.height) < 0.04,
        selection: { ...selection }
      }
    })
    overlay.addEventListener('pointermove', (event) => {
      if (!drag || !overlay) return
      const bounds = overlay.getBoundingClientRect(),
        dx = (event.clientX - bounds.left) / bounds.width - drag.startX,
        dy = (event.clientY - bounds.top) / bounds.height - drag.startY
      dragRect = drag.resize
        ? {
            ...drag.rect,
            width: clamp(drag.rect.width + dx, 0.02, 2),
            height: clamp(drag.rect.height + dy, 0.02, 2)
          }
        : { ...drag.rect, x: clamp(drag.rect.x + dx, -1, 1), y: clamp(drag.rect.y + dy, -1, 1) }
      paintOverlay()
    })
    overlay.addEventListener('pointerup', (event) => {
      if (!overlay || !drag) return
      const result = dragRect ?? drag.rect,
        target = drag.selection
      drag = null
      dragRect = null
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId)
      const receive = gestureReceiver
      gestureReceiver = null
      receive?.({ selection: target, rect: result })
      paintOverlay()
    })
    overlay.addEventListener('pointercancel', () => {
      drag = null
      dragRect = null
      paintOverlay()
    })
    paintOverlay()
  }

  async function render(
    document: VideoStudioDocument,
    output: HTMLCanvasElement,
    time: number
  ): Promise<void> {
    studio = document
    canvas = output
    const edit = document.edit,
      ctx = canvas.getContext('2d')
    if (!edit || !ctx) return
    frame += 1
    const frozen =
      host.__cioEditPreviewDisabled || new URLSearchParams(location.search).has('cio-capture')
    const playing = !frozen && (host.__cioTransport?.playing ?? false)
    const assets = new Map(edit.assets.map((asset) => [asset.id, asset]))
    const tracks = new Map(edit.tracks.map((track, index) => [track.id, { ...track, index }]))
    const clips = edit.clips
      .filter((clip) => time >= clip.start && time < clip.start + clip.duration)
      .sort(
        (a, b) =>
          (tracks.get(a.trackId)?.index ?? 0) - (tracks.get(b.trackId)?.index ?? 0) ||
          a.start - b.start
      )
    const visual = clips.filter((clip) => {
      const asset = assets.get(clip.assetId),
        track = tracks.get(clip.trackId)
      return asset && asset.kind !== 'audio' && !track?.hidden
    })
    // Hold the preceding source frame during an incoming dissolve.
    for (const clip of [...visual])
      if (clip.transition.kind === 'dissolve' && time < clip.start + clip.transition.duration) {
        const previous = edit.clips
          .filter(
            (candidate) =>
              candidate.trackId === clip.trackId &&
              candidate.id !== clip.id &&
              Math.abs(candidate.start + candidate.duration - clip.start) < 0.05
          )
          .at(-1)
        if (previous && !visual.includes(previous)) visual.push(previous)
      }
    visual.sort(
      (a, b) =>
        (tracks.get(a.trackId)?.index ?? 0) - (tracks.get(b.trackId)?.index ?? 0) ||
        a.start - b.start
    )
    if (visual.length > 8) throw new Error('At most eight picture layers can play at the same time')
    if (visual.filter((clip) => assets.get(clip.assetId)?.kind === 'video').length > 4)
      throw new Error('At most four video sources can play at the same time')
    if (
      playing &&
      clips.filter(
        (clip) =>
          assets.get(clip.assetId)?.hasAudio && clip.volume > 0 && !tracks.get(clip.trackId)?.muted
      ).length > 16
    )
      throw new Error('At most sixteen audio clips can play at the same time')
    if (
      edit.regions.filter((region) => time >= region.start && time < region.start + region.duration)
        .length > 8
    )
      throw new Error('At most eight privacy regions can play at the same time')
    wanted = new Set(visual.map((clip) => `picture-${clip.id}`))
    if (playing)
      for (const clip of clips) {
        if (
          assets.get(clip.assetId)?.hasAudio &&
          !tracks.get(clip.trackId)?.muted &&
          clip.volume > 0
        )
          wanted.add(`audio-${clip.id}`)
      }
    // Release inactive pictures at cuts. Large imported stills must not remain
    // decoded while the user scrubs through other clips.
    for (const [key, entry] of media)
      if (!wanted.has(key) && !(entry.element instanceof HTMLAudioElement)) {
        release(entry)
        media.delete(key)
      }
    ctx.save()
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    if (edit.background !== 'composition') {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    for (const clip of visual) {
      const asset = assets.get(clip.assetId)
      if (!asset) continue
      const element = await load(
        `picture-${clip.id}`,
        asset.source,
        asset.kind === 'image' ? 'image' : 'video'
      )
      if (element instanceof HTMLMediaElement) {
        element.dataset.cioTrackStart = String(clip.start)
        element.dataset.cioTrackTrim = String(clip.sourceStart)
        element.dataset.cioTrackDuration = String(clip.duration)
        element.dataset.cioTrackSpeed = String(clip.speed)
        element.playbackRate = clip.speed
        const local = clamp(time - clip.start, 0, Math.max(0, clip.duration - 0.001))
        await hooks.seekMedia(element, clip.sourceStart + local * clip.speed)
        if (playing && time < clip.start + clip.duration) void element.play().catch(() => undefined)
        else element.pause()
      }
      const progress = clip.transition.duration
        ? clamp((time - clip.start) / clip.transition.duration)
        : 1
      const rect = clip.rect,
        grade = clip.grade
      const filter =
        `brightness(${2 ** grade.exposure}) contrast(${grade.contrast}) saturate(${grade.saturation}) hue-rotate(${grade.hue}deg)` +
        temperatureFilter(clip)
      ctx.save()
      ctx.filter = filter
      ctx.globalAlpha =
        clip.opacity *
        (clip.transition.kind === 'dissolve' || clip.transition.kind === 'fade' ? progress : 1)
      let x = rect.x * canvas.width,
        y = rect.y * canvas.height,
        width = rect.width * canvas.width,
        height = rect.height * canvas.height
      if (clip.transition.kind === 'slide') x -= (1 - progress) * width
      if (clip.transition.kind === 'zoom') {
        const scale = 0.8 + progress * 0.2
        x += (width * (1 - scale)) / 2
        y += (height * (1 - scale)) / 2
        width *= scale
        height *= scale
      }
      const sourceWidth =
        element instanceof HTMLVideoElement
          ? element.videoWidth
          : element instanceof HTMLImageElement
            ? element.naturalWidth
            : width
      const sourceHeight =
        element instanceof HTMLVideoElement
          ? element.videoHeight
          : element instanceof HTMLImageElement
            ? element.naturalHeight
            : height
      const crop = clip.crop,
        croppedWidth = sourceWidth * crop.width,
        croppedHeight = sourceHeight * crop.height
      const scale = Math.min(width / Math.max(1, croppedWidth), height / Math.max(1, croppedHeight))
      const drawnWidth = croppedWidth * scale,
        drawnHeight = croppedHeight * scale
      ctx.drawImage(
        element as HTMLVideoElement | HTMLImageElement,
        sourceWidth * crop.x,
        sourceHeight * crop.y,
        croppedWidth,
        croppedHeight,
        x + (width - drawnWidth) / 2,
        y + (height - drawnHeight) / 2,
        drawnWidth,
        drawnHeight
      )
      ctx.restore()
    }
    for (const region of edit.regions)
      if (time >= region.start && time < region.start + region.duration) {
        const x = clamp(region.x) * canvas.width,
          y = clamp(region.y) * canvas.height,
          width = Math.min(region.width * canvas.width, canvas.width - x),
          height = Math.min(region.height * canvas.height, canvas.height - y)
        if (width < 1 || height < 1) continue
        if (region.kind === 'cover') {
          ctx.fillStyle = region.color
          ctx.fillRect(x, y, width, height)
        } else if (scratchContext) {
          const divisor =
            region.kind === 'pixelate' ? region.amount : Math.max(2, region.amount / 3)
          scratch.width = Math.max(1, Math.min(512, Math.round(width / divisor)))
          scratch.height = Math.max(1, Math.min(512, Math.round(height / divisor)))
          scratchContext.clearRect(0, 0, scratch.width, scratch.height)
          scratchContext.drawImage(canvas, x, y, width, height, 0, 0, scratch.width, scratch.height)
          ctx.save()
          ctx.imageSmoothingEnabled = region.kind !== 'pixelate'
          ctx.filter = region.kind === 'blur' ? `blur(${Math.max(2, region.amount / 3)}px)` : 'none'
          ctx.beginPath()
          ctx.rect(x, y, width, height)
          ctx.clip()
          ctx.drawImage(scratch, x, y, width, height)
          ctx.restore()
        }
      }
    hooks.drawCaptions(ctx, time, canvas.width, canvas.height)
    ctx.restore()
    if (playing)
      for (const clip of clips) {
        const asset = assets.get(clip.assetId),
          track = tracks.get(clip.trackId)
        if (!asset?.hasAudio || track?.muted || clip.volume <= 0) continue
        const element = await load(`audio-${clip.id}`, asset.source, 'audio')
        if (!(element instanceof HTMLMediaElement)) continue
        element.dataset.cioTrackStart = String(clip.start)
        element.dataset.cioTrackTrim = String(clip.sourceStart)
        element.dataset.cioTrackDuration = String(clip.duration)
        element.dataset.cioTrackSpeed = String(clip.speed)
        element.playbackRate = clip.speed
        audioSettings(element, clip, time)
        if (
          element.paused ||
          Math.abs(element.currentTime - (clip.sourceStart + (time - clip.start) * clip.speed)) >
            0.25
        )
          await hooks.seekMedia(element, clip.sourceStart + (time - clip.start) * clip.speed)
        void element.play().catch(() => undefined)
      }
    for (const [key, entry] of media)
      if (entry.used < frame) {
        if (entry.element instanceof HTMLMediaElement) {
          entry.element.pause()
          entry.element.dataset.cioTrackDuration = '0'
        }
        if (frame - entry.used > 90) {
          release(entry)
          media.delete(key)
        }
      }
    if (!playing && audioContext?.state === 'running')
      void audioContext.suspend().catch(() => undefined)
    if (!host.__cioEditPreviewDisabled && selection) {
      installOverlay()
      paintOverlay()
    }
  }

  function stopEditing(): void {
    selection = null
    drag = null
    dragRect = null
    observer?.disconnect()
    observer = null
    overlay?.remove()
    overlay = null
    const resolve = gestureReceiver
    gestureReceiver = null
    resolve?.(null)
  }
  return {
    render,
    setSelection(next: VideoEditorSelection): void {
      selection = next
      if (selection) {
        installOverlay()
        paintOverlay()
      } else {
        observer?.disconnect()
        observer = null
        overlay?.remove()
        overlay = null
      }
    },
    takeGesture(): Promise<VideoEditorGesture | null> {
      gestureReceiver?.(null)
      return new Promise((resolve) => {
        gestureReceiver = resolve
      })
    },
    stopEditing,
    dispose(): void {
      stopEditing()
      for (const entry of media.values()) release(entry)
      media.clear()
      filterRoot?.remove()
      gradeFilters.clear()
      void audioContext?.close()
    }
  }
}
