import './app.css'
import { fitWithin, MAX_SCREENSHOT_DIMENSION } from '$shared/image-payload'
import type { ScreenshotFrame, ScreenshotOverlayBridge } from '$shared/screenshot/overlay-bridge'
import {
  dragRegion,
  regionInFrame,
  type Point,
  type Region,
  type Size
} from '$shared/screenshot/region'

/**
 * The entry for the Windows and X11 region selector.
 *
 * It shows one display frozen at the moment of the chord. Cropping, fitting and
 * PNG encoding happen here, in the overlay's process, so main only writes bytes.
 */

declare global {
  interface Window {
    screenshotOverlay: ScreenshotOverlayBridge
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`The overlay is missing #${id}`)
  return element as T
}

const bridge = window.screenshotOverlay
const canvas = requireElement<HTMLCanvasElement>('frame')
const shade = requireElement('shade')
const box = requireElement('selection')
const hint = requireElement('hint')

let origin: Point | null = null
let encoding = false

function surface(): Size {
  return { width: window.innerWidth, height: window.innerHeight }
}

function paintFrame({ pixels, width, height }: ScreenshotFrame): void {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The overlay has no 2D canvas')
  canvas.width = width
  canvas.height = height
  const image = context.createImageData(width, height)
  const target = image.data
  for (let index = 0; index < target.length; index += 4) {
    target[index] = pixels[index + 2]!
    target[index + 1] = pixels[index + 1]!
    target[index + 2] = pixels[index]!
    // X11 leaves the alpha byte unset, which would paint the screen transparent.
    target[index + 3] = 255
  }
  context.putImageData(image, 0, 0)
}

function showRegion(region: Region | null): void {
  box.hidden = !region
  shade.hidden = !!region
  hint.hidden = !!origin
  if (!region) return
  box.style.left = `${region.x}px`
  box.style.top = `${region.y}px`
  box.style.width = `${region.width}px`
  box.style.height = `${region.height}px`
}

async function finish(region: Region): Promise<void> {
  const source = regionInFrame(region, surface(), canvas)
  const size = fitWithin(source.width, source.height, MAX_SCREENSHOT_DIMENSION)
  const bitmap = await createImageBitmap(canvas, source.x, source.y, source.width, source.height, {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality: 'high'
  })
  const output = new OffscreenCanvas(size.width, size.height)
  const context = output.getContext('2d')
  if (!context) throw new Error('The selection has no 2D canvas')
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const blob = await output.convertToBlob({ type: 'image/png' })
  bridge.select({
    png: new Uint8Array(await blob.arrayBuffer()),
    sourceWidth: source.width,
    sourceHeight: source.height
  })
}

function listen(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') bridge.cancel()
  })
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    bridge.cancel()
  })
  window.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || encoding) return
    origin = { x: event.clientX, y: event.clientY }
    document.body.setPointerCapture(event.pointerId)
    showRegion(null)
  })
  window.addEventListener('pointermove', (event) => {
    if (!origin || encoding) return
    showRegion(dragRegion(origin, { x: event.clientX, y: event.clientY }, surface()))
  })
  window.addEventListener('pointerup', (event) => {
    if (!origin || encoding) return
    const region = dragRegion(origin, { x: event.clientX, y: event.clientY }, surface())
    origin = null
    showRegion(region)
    if (!region) return
    encoding = true
    finish(region).catch((error: unknown) => bridge.fail(String(error)))
  })
  window.addEventListener('pointercancel', () => {
    origin = null
    if (!encoding) showRegion(null)
  })
}

async function start(): Promise<void> {
  const frame = await bridge.frame()
  if (!frame) return bridge.cancel()
  paintFrame(frame)
  listen()
  bridge.ready()
}

start().catch((error: unknown) => bridge.fail(String(error)))
