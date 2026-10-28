import type { VideoStudioDocument } from '../../lib/video/studio'
import type {
  VideoEditClip,
  VideoEditRegion,
  VideoEditRect,
  VideoEditorGesture,
  VideoEditorSelection,
  VideoCaptionAppearance
} from '../../lib/video/edit'

export interface VideoEditRendererHooks {
  seekMedia(media: HTMLMediaElement, seconds: number): Promise<void>
  mediaReady(media: HTMLMediaElement): Promise<void>
  drawCaptions(ctx: CanvasRenderingContext2D, seconds: number, width: number, height: number): void
  captionBounds(index: number, width: number, height: number): VideoEditRect | null
  captionAppearance(index: number): VideoCaptionAppearance
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
  const regionMasks = new WeakMap<VideoEditRegion, { key: string; path: Path2D }>()
  const media = new Map<string, Media>()
  let wanted = new Set<string>()
  const graphs = new Map<HTMLMediaElement, AudioGraph>()
  let audioContext: AudioContext | null = null
  let frame = 0
  let selection: VideoEditorSelection = null
  let editing = false
  let currentTime = 0
  let studio: VideoStudioDocument | null = null
  let canvas: HTMLCanvasElement | null = null
  let overlay: HTMLCanvasElement | null = null
  let observer: ResizeObserver | null = null
  let gestureReceiver: ((gesture: VideoEditorGesture | null) => void) | null = null
  let drag: {
    startX: number
    startY: number
    rect: VideoEditRect
    edgeX: number
    edgeY: number
    appearance?: VideoCaptionAppearance
    selection: Exclude<VideoEditorSelection, null>
  } | null = null
  let brushStroke: { x: number; y: number }[] | null = null
  let dragRect: VideoEditRect | null = null
  const pendingGestures: VideoEditorGesture[] = []
  let painting = false
  let paintAgain = false
  const emitGesture = (gesture: VideoEditorGesture): void => {
    const receive = gestureReceiver
    gestureReceiver = null
    if (receive) receive(gesture)
    else pendingGestures.push(gesture)
    if (pendingGestures.length > 16) pendingGestures.shift()
  }
  async function paintLive(): Promise<void> {
    paintAgain = true
    if (painting) return
    painting = true
    try {
      do {
        paintAgain = false
        await host.__cioTransport?.freezeAt?.(host.__cioTransport.time)
      } while (paintAgain)
    } finally {
      painting = false
    }
  }
  const scratch = document.createElement('canvas')
  const scratchContext = scratch.getContext('2d')
  const gradeFilters = new Map<
    string,
    { filter: SVGFilterElement; matrix: SVGFEColorMatrixElement; used: number; value: number }
  >()
  let filterRoot: SVGSVGElement | null = null
  const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value))
  const host = globalThis as typeof globalThis & {
    __cioTransport?: {
      playing: boolean
      time: number
      freezeAt?(seconds: number): Promise<unknown>
    }
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
    if (!studio || !selection || selection.kind === 'brush') return null
    const target = selection
    if (target.kind === 'clip')
      return studio.edit?.clips.find((clip) => clip.id === target.id)?.rect ?? null
    if (target.kind === 'region')
      return studio.edit?.regions.find((region) => region.id === target.id) ?? null
    return canvas ? hooks.captionBounds(target.index, canvas.width, canvas.height) : null
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
    if (selection?.kind === 'brush') {
      overlay.style.pointerEvents = 'auto'
      overlay.style.cursor = 'crosshair'
      if (brushStroke?.length) {
        ctx.strokeStyle =
          getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() ||
          '#e7bb42'
        ctx.lineWidth = selection.size * overlay.width
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        brushStroke.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point.x * overlay!.width, point.y * overlay!.height)
          else ctx.lineTo(point.x * overlay!.width, point.y * overlay!.height)
        })
        ctx.stroke()
      }
      return
    }
    if (!rect) {
      overlay.style.pointerEvents = editing ? 'auto' : 'none'
      overlay.style.cursor = 'default'
      return
    }
    overlay.style.pointerEvents = 'auto'
    overlay.style.cursor = 'move'
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
      [x + w, y + h],
      [x + w / 2, y],
      [x + w / 2, y + h],
      [x, y + h / 2],
      [x + w, y + h / 2]
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
    function hit(event: PointerEvent | MouseEvent): VideoEditorSelection {
      if (!overlay || !studio) return null
      const bounds = overlay.getBoundingClientRect(),
        x = (event.clientX - bounds.left) / bounds.width,
        y = (event.clientY - bounds.top) / bounds.height
      const contains = (rect: VideoEditRect): boolean =>
        x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
      const current = selectedRect()
      if (
        current &&
        selection &&
        (Math.abs(x - current.x) < 10 / bounds.width ||
          Math.abs(x - current.x - current.width) < 10 / bounds.width ||
          Math.abs(y - current.y) < 10 / bounds.height ||
          Math.abs(y - current.y - current.height) < 10 / bounds.height) &&
        x >= current.x - 0.02 &&
        x <= current.x + current.width + 0.02 &&
        y >= current.y - 0.02 &&
        y <= current.y + current.height + 0.02
      )
        return selection
      const caption = studio.captions.findIndex(
        (caption) => currentTime >= caption.start && currentTime < caption.end
      )
      const captionRect =
        caption >= 0 && canvas ? hooks.captionBounds(caption, canvas.width, canvas.height) : null
      if (captionRect && contains(captionRect)) return { kind: 'caption', index: caption }
      const region = studio.edit?.regions.findLast(
        (region) =>
          currentTime >= region.start &&
          currentTime < region.start + region.duration &&
          contains(region)
      )
      if (region) return { kind: 'region', id: region.id }
      const clips =
        studio.edit?.clips.filter(
          (clip) =>
            currentTime >= clip.start &&
            currentTime < clip.start + clip.duration &&
            studio?.edit?.assets.find((asset) => asset.id === clip.assetId)?.kind !== 'audio' &&
            !studio?.edit?.tracks.find((track) => track.id === clip.trackId)?.hidden
        ) ?? []
      clips.sort(
        (a, b) =>
          (studio?.edit?.tracks.findIndex((track) => track.id === b.trackId) ?? 0) -
          (studio?.edit?.tracks.findIndex((track) => track.id === a.trackId) ?? 0)
      )
      const clip = clips.findLast((clip) => contains(clip.rect))
      return clip ? { kind: 'clip', id: clip.id } : null
    }
    overlay.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const target = hit(event)
      if (!target || !overlay) return
      selection = target
      const rect = selectedRect()
      if (rect)
        emitGesture({
          kind: 'context',
          selection: target,
          rect,
          point: { x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight }
        })
      paintOverlay()
    })
    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      if (selection?.kind === 'brush' && overlay && !host.__cioTransport?.playing) {
        const bounds = overlay.getBoundingClientRect()
        brushStroke = [
          {
            x: clamp((event.clientX - bounds.left) / bounds.width),
            y: clamp((event.clientY - bounds.top) / bounds.height)
          }
        ]
        overlay.setPointerCapture(event.pointerId)
        event.preventDefault()
        paintOverlay()
        return
      }
      const target = hit(event)
      if (target) {
        selection = target
        const rect = selectedRect()
        if (rect) emitGesture({ kind: 'select', selection: target, rect })
        paintOverlay()
      }
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
      if (selection.kind === 'clip') {
        const id = selection.id
        const clip = studio?.edit?.clips.find((clip) => clip.id === id)
        if (studio?.edit?.tracks.find((track) => track.id === clip?.trackId)?.locked) return
      }
      event.preventDefault()
      overlay.setPointerCapture(event.pointerId)
      drag = {
        startX: x,
        startY: y,
        rect: { ...rect },
        edgeX:
          Math.abs(x - rect.x) < 9 / bounds.width
            ? -1
            : Math.abs(x - rect.x - rect.width) < 9 / bounds.width
              ? 1
              : 0,
        edgeY:
          Math.abs(y - rect.y) < 9 / bounds.height
            ? -1
            : Math.abs(y - rect.y - rect.height) < 9 / bounds.height
              ? 1
              : 0,
        appearance:
          selection.kind === 'caption' ? hooks.captionAppearance(selection.index) : undefined,
        selection: { ...selection }
      }
    })
    overlay.addEventListener('pointermove', (event) => {
      if (brushStroke && selection?.kind === 'brush' && overlay) {
        const bounds = overlay.getBoundingClientRect(),
          last = brushStroke.at(-1)!,
          point = {
            x: clamp((event.clientX - bounds.left) / bounds.width),
            y: clamp((event.clientY - bounds.top) / bounds.height)
          }
        const distance = Math.hypot(
          point.x - last.x,
          ((point.y - last.y) * bounds.height) / bounds.width
        )
        const steps = Math.min(256 - brushStroke.length, Math.ceil(distance / (selection.size / 4)))
        for (let i = 1; i <= steps; i++)
          brushStroke.push({
            x: last.x + ((point.x - last.x) * i) / steps,
            y: last.y + ((point.y - last.y) * i) / steps
          })
        paintOverlay()
        return
      }
      if (!overlay) return
      if (!drag) {
        const rect = selectedRect()
        if (!rect) return
        const bounds = overlay.getBoundingClientRect()
        const x = (event.clientX - bounds.left) / bounds.width
        const y = (event.clientY - bounds.top) / bounds.height
        const horizontal =
          Math.abs(x - rect.x) < 9 / bounds.width ||
          Math.abs(x - rect.x - rect.width) < 9 / bounds.width
        const vertical =
          Math.abs(y - rect.y) < 9 / bounds.height ||
          Math.abs(y - rect.y - rect.height) < 9 / bounds.height
        const inside =
          x >= rect.x - 0.02 &&
          x <= rect.x + rect.width + 0.02 &&
          y >= rect.y - 0.02 &&
          y <= rect.y + rect.height + 0.02
        overlay.style.cursor = !inside
          ? 'default'
          : horizontal && vertical
            ? x < rect.x + rect.width / 2 === y < rect.y + rect.height / 2
              ? 'nwse-resize'
              : 'nesw-resize'
            : horizontal
              ? 'ew-resize'
              : vertical
                ? 'ns-resize'
                : 'move'
        return
      }
      const bounds = overlay.getBoundingClientRect(),
        dx = (event.clientX - bounds.left) / bounds.width - drag.startX,
        dy = (event.clientY - bounds.top) / bounds.height - drag.startY
      const rect = { ...drag.rect }
      if (!drag.edgeX && !drag.edgeY) {
        rect.x += dx
        rect.y += dy
      } else {
        if (drag.edgeX) {
          rect.width = clamp(rect.width + drag.edgeX * dx, 0.02, 2)
          if (drag.edgeX < 0) rect.x += drag.rect.width - rect.width
        }
        if (drag.edgeY) {
          rect.height = clamp(rect.height + drag.edgeY * dy, 0.02, 2)
          if (drag.edgeY < 0) rect.y += drag.rect.height - rect.height
        }
      }
      rect.x = clamp(rect.x, -1, 1)
      rect.y = clamp(rect.y, -1, 1)
      if (studio && drag.selection.kind === 'caption' && drag.appearance && canvas) {
        const before = drag.appearance
        const appearance = { ...before }
        if (!drag.edgeX && !drag.edgeY) {
          appearance.x = clamp(before.x + dx)
          appearance.y = clamp(before.y + dy)
        } else {
          const factor = drag.edgeY ? clamp(rect.height / drag.rect.height, 0.1, 8) : 1
          appearance.size = clamp(before.size * factor, 0.01, 0.15)
          appearance.width = clamp(drag.edgeX ? rect.width : before.width, 0.1, 1)
          appearance.x = clamp(rect.x + rect.width / 2)
          studio.captions[drag.selection.index].appearance = appearance
          const actual = hooks.captionBounds(drag.selection.index, canvas.width, canvas.height)
          if (actual && drag.edgeY) {
            const anchor = drag.edgeY < 0 ? drag.rect.y + drag.rect.height : drag.rect.y
            appearance.y = clamp(
              appearance.y + anchor - (drag.edgeY < 0 ? actual.y + actual.height : actual.y)
            )
          }
        }
        studio.captions[drag.selection.index].appearance = appearance
        dragRect = hooks.captionBounds(drag.selection.index, canvas.width, canvas.height)
      } else {
        dragRect = rect
        if (studio && drag.selection.kind === 'clip') {
          const id = drag.selection.id
          const target = studio.edit?.clips.find((clip) => clip.id === id)
          if (target) target.rect = rect
        } else if (studio && drag.selection.kind === 'region') {
          const id = drag.selection.id
          const target = studio.edit?.regions.find((region) => region.id === id)
          if (target) Object.assign(target, rect)
        }
      }
      void paintLive()
      paintOverlay()
    })
    overlay.addEventListener('pointerup', (event) => {
      if (brushStroke?.length && selection?.kind === 'brush' && overlay && canvas) {
        const radius = selection.size / 2,
          radiusY = (radius * canvas.width) / canvas.height
        const left = clamp(Math.min(...brushStroke.map((p) => p.x)) - radius),
          top = clamp(Math.min(...brushStroke.map((p) => p.y)) - radiusY)
        const right = clamp(Math.max(...brushStroke.map((p) => p.x)) + radius),
          bottom = clamp(Math.max(...brushStroke.map((p) => p.y)) + radiusY)
        const rect = {
          x: left,
          y: top,
          width: Math.max(0.01, right - left),
          height: Math.max(0.01, bottom - top)
        }
        const target = { kind: 'region' as const, id: crypto.randomUUID() }
        emitGesture({
          kind: 'paint',
          selection: target,
          rect,
          stroke: brushStroke.map((p) => ({
            x: clamp((p.x - left) / rect.width),
            y: clamp((p.y - top) / rect.height)
          })),
          brushSize: Math.min(2, selection.size / rect.width)
        })
        brushStroke = null
        if (overlay.hasPointerCapture(event.pointerId))
          overlay.releasePointerCapture(event.pointerId)
        paintOverlay()
        return
      }
      if (!overlay || !drag) return
      const result = dragRect ?? drag.rect,
        target = drag.selection,
        changed = dragRect !== null && JSON.stringify(dragRect) !== JSON.stringify(drag.rect),
        appearance =
          target.kind === 'caption' ? studio?.captions[target.index]?.appearance : undefined
      drag = null
      dragRect = null
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId)
      if (changed)
        emitGesture({
          selection: target,
          rect: result,
          ...(appearance ? { captionAppearance: appearance } : {})
        })
      paintOverlay()
    })
    overlay.addEventListener('pointercancel', () => {
      if (drag && studio) {
        const target = drag.selection
        if (target.kind === 'caption') studio.captions[target.index].appearance = drag.appearance
        if (target.kind === 'clip') {
          const clip = studio.edit?.clips.find((clip) => clip.id === target.id)
          if (clip) clip.rect = drag.rect
        }
        if (target.kind === 'region') {
          const region = studio.edit?.regions.find((region) => region.id === target.id)
          if (region) Object.assign(region, drag.rect)
        }
        void paintLive()
      }
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
    currentTime = time
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
          (tracks.get(b.trackId)?.index ?? 0) - (tracks.get(a.trackId)?.index ?? 0) ||
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
        (tracks.get(b.trackId)?.index ?? 0) - (tracks.get(a.trackId)?.index ?? 0) ||
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
    const prepared = new Map<string, HTMLVideoElement | HTMLAudioElement | HTMLImageElement>()
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
      prepared.set(clip.id, element)
    }
    // All asynchronous decoding is finished. Paint every layer synchronously so
    // scrubbing never presents a cleared canvas or a partly drawn composition.
    ctx.save()
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    if (edit.background !== 'composition') {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    for (const clip of visual) {
      const element = prepared.get(clip.id)
      if (!element) continue
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
        ctx.save()
        if (region.stroke?.length) {
          const key = [x, y, width, height, region.brushSize].join(':')
          let cached = regionMasks.get(region)
          if (!cached || cached.key !== key) {
            const path = new Path2D(),
              radius = ((region.brushSize ?? 0.1) * width) / 2
            for (const point of region.stroke) {
              path.moveTo(x + point.x * width + radius, y + point.y * height)
              path.arc(x + point.x * width, y + point.y * height, radius, 0, Math.PI * 2)
            }
            cached = { key, path }
            regionMasks.set(region, cached)
          }
          ctx.clip(cached.path)
        }
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
        ctx.restore()
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
    if (!host.__cioEditPreviewDisabled && editing) {
      installOverlay()
      paintOverlay()
    }
  }

  function stopEditing(): void {
    editing = false
    brushStroke = null
    pendingGestures.length = 0
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
    get editing() {
      return editing
    },
    setSelection(next: VideoEditorSelection): void {
      editing = true
      selection = next
      installOverlay()
      paintOverlay()
    },
    takeGesture(): Promise<VideoEditorGesture | null> {
      const pending = pendingGestures.shift()
      if (pending) return Promise.resolve(pending)
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
