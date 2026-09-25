/**
 * A video composition as a project folder: the one thing an agent writes to
 * make a video, as pure functions.
 *
 * The composition is a small web project rather than a timeline document. A
 * timeline can only describe arrangement, while an edit needs to compute:
 * twelve cards generated from a list, a counter that climbs, a caption that
 * follows a beat. Those are programs, and the web platform already runs
 * programs, typesets text, loads fonts and draws at any size. So a composition
 * is `index.html` plus whatever it needs, and the app supplies the two things a
 * page cannot do on its own: a deterministic frame at an exact time, and a way
 * to watch it while it is still changing.
 *
 * The whole contract is one global function and one manifest, so an agent can
 * hold it in its head:
 *
 * 1. `window.cioRenderFrame(seconds)` draws the frame at that time. Nothing
 *    else is required of the project, and nothing else is assumed.
 * 2. `composition.json` states the frame size, the rate and the length, which
 *    is what the app needs before the page has run a line.
 *
 * Everything here is validated before the app loads anything, so a mistake is
 * one readable sentence rather than a blank stage.
 */

/** Version of the manifest this module reads. A future shape bumps this. */
export const VIDEO_PROJECT_VERSION = 1

/**
 * Where a composition goes when nobody names a folder.
 *
 * `.cio/` is the app's scratch tree and is ignored by Git, so a video written
 * here is explorable work rather than a change to the product.
 */
export const VIDEO_PROJECT_ROOT = '.cio/videos'

/** The file the stage loads. */
export const VIDEO_PROJECT_ENTRY = 'index.html'

/** The manifest beside it, which the app reads before the page runs. */
export const VIDEO_PROJECT_MANIFEST = 'composition.json'

/** The global the project defines, and the only thing the app calls on it. */
export const VIDEO_RENDER_FUNCTION = 'cioRenderFrame'

/**
 * Whether a load is a request for one exact frame rather than a viewing.
 *
 * A preview wants the composition moving, because watching it change is the
 * point. A capture wants it frozen at a time, because a screenshot of a moving
 * page is a screenshot of a random frame. The parameter is how one project
 * serves both without knowing which one it is being asked for.
 */
export const VIDEO_CAPTURE_PARAM = 'cio-capture'

/** Seconds on the timeline a capture is asking for. */
export const VIDEO_TIME_PARAM = 'cio-time'

/** Ceilings, so a hand-written project cannot turn one load into a thousand files. */
export const MAX_VIDEO_PROJECT_AUDIO = 24

/** Ceilings on one field, so a bad manifest cannot inflate a process argument. */
export const MAX_VIDEO_PROJECT_PATH_LENGTH = 1_024

/** Frame limits. An encoder needs even dimensions, so the manifest requires them. */
export const MIN_VIDEO_DIMENSION = 16
export const MAX_VIDEO_DIMENSION = 7_680
export const MIN_VIDEO_FPS = 1
export const MAX_VIDEO_FPS = 120

/** Length limits. A composition is short form; an hour is already generous. */
export const MIN_VIDEO_SECONDS = 0.05
export const MAX_VIDEO_SECONDS = 3_600

/** The frame shapes an agent is most often asked for, named so a reply can say them. */
export const VIDEO_FRAME_PRESETS: readonly {
  readonly label: string
  readonly width: number
  readonly height: number
}[] = [
  { label: 'Landscape 1080p', width: 1920, height: 1080 },
  { label: 'Portrait 1080p', width: 1080, height: 1920 },
  { label: 'Square 1080p', width: 1080, height: 1080 },
  { label: 'Landscape 720p', width: 1280, height: 720 },
  { label: 'Portrait 720p', width: 720, height: 1280 }
]

/** What `composition.json` declares about a composition. */
export interface VideoProjectManifest {
  version: number
  width: number
  height: number
  fps: number
  /** Seconds the composition runs. */
  duration: number
  /** `#rrggbb` behind everything. Defaults to black. */
  background: string
  /**
   * Sound the composition uses, as project-relative paths in the order they
   * should be layered. The page plays them for a viewing; the app needs the
   * list in order to mux them into an exported file, because a page cannot hand
   * back its own mixed audio.
   */
  audio: string[]
}

const HEX_COLOUR_PATTERN = /^#[0-9a-f]{6}$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new TypeError(message)
}

function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`)
  if (value < minimum || value > maximum) {
    fail(`${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

/**
 * A dimension a video encoder can actually take.
 *
 * Odd dimensions are not a matter of taste here: h264 and most of the other
 * codecs subsample colour, so an odd width or height is an encoding failure
 * rather than a smaller frame. Refusing it at the manifest turns a failed
 * export into a sentence about the number that has to change.
 */
function evenDimension(value: unknown, label: string): number {
  const dimension = boundedNumber(value, label, MIN_VIDEO_DIMENSION, MAX_VIDEO_DIMENSION)
  if (Math.round(dimension) % 2 !== 0) {
    fail(`${label} must be an even number of pixels, because video encoders require it`)
  }
  return Math.round(dimension)
}

function projectRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a project-relative path`)
  const trimmed = value.trim()
  if (trimmed.length === 0) fail(`${label} must not be empty`)
  if (trimmed.length > MAX_VIDEO_PROJECT_PATH_LENGTH) fail(`${label} is too long`)
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/u.test(trimmed)) {
    fail(`${label} must be relative to the composition folder, not an absolute path`)
  }
  const segments = trimmed.split(/[\\/]+/u).filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '..')) {
    fail(`${label} must stay inside the composition folder`)
  }
  if (segments.length === 0) fail(`${label} must name a file`)
  return segments.join('/')
}

/**
 * Read and check a manifest.
 *
 * Absent fields fall back rather than failing where a sensible default exists,
 * so a minimal manifest is legal: a composition that only says its size and its
 * length is a composition. A field that is present and wrong is always an
 * error, because silently correcting a number the author wrote is how a render
 * ends up not being the one that was asked for.
 */
export function describeVideoProjectManifest(value: unknown): VideoProjectManifest {
  if (!isRecord(value)) fail('composition.json must hold a JSON object')
  const version = value['version'] ?? VIDEO_PROJECT_VERSION
  if (version !== VIDEO_PROJECT_VERSION) {
    fail(`composition.json version must be ${VIDEO_PROJECT_VERSION}`)
  }
  const width = evenDimension(value['width'], 'width')
  const height = evenDimension(value['height'], 'height')
  const fps = Math.round(boundedNumber(value['fps'], 'fps', MIN_VIDEO_FPS, MAX_VIDEO_FPS))
  const duration = boundedNumber(
    value['duration'],
    'duration',
    MIN_VIDEO_SECONDS,
    MAX_VIDEO_SECONDS
  )
  const rawBackground = value['background']
  let background = '#000000'
  if (rawBackground !== undefined) {
    if (typeof rawBackground !== 'string' || !HEX_COLOUR_PATTERN.test(rawBackground.trim())) {
      fail('background must be a #rrggbb colour')
    }
    background = rawBackground.trim().toLowerCase()
  }
  const rawAudio = value['audio']
  let audio: string[] = []
  if (rawAudio !== undefined) {
    if (!Array.isArray(rawAudio)) fail('audio must be a list of project-relative paths')
    if (rawAudio.length > MAX_VIDEO_PROJECT_AUDIO) {
      fail(`audio must hold at most ${MAX_VIDEO_PROJECT_AUDIO} files`)
    }
    audio = rawAudio.map((entry, index) => projectRelativePath(entry, `audio[${index}]`))
  }
  return { version: VIDEO_PROJECT_VERSION, width, height, fps, duration, background, audio }
}

/**
 * The URL a viewing loads: the project as it wants to be seen, moving.
 *
 * The time is left to the project, so a preview starts where the composition
 * says it starts rather than where the app assumes.
 */
export function videoPlayUrl(baseUrl: string): string {
  return baseUrl
}

/**
 * The URL a capture loads: one frozen frame.
 *
 * `cio-capture` tells a well-behaved project not to start its own animation
 * loop, and `cio-time` says which frame. The app still calls
 * `cioRenderFrame(seconds)` itself before it captures, so a project that
 * ignores both parameters is still captured at the right frame; the parameters
 * exist so the page is not racing the capture while it settles.
 */
export function videoCaptureUrl(baseUrl: string, seconds: number): string {
  const url = new URL(baseUrl)
  url.searchParams.set(VIDEO_CAPTURE_PARAM, '1')
  url.searchParams.set(VIDEO_TIME_PARAM, seconds.toFixed(3))
  return url.toString()
}

/** Seconds on the timeline, clamped to what the manifest says the composition holds. */
export function videoClampTime(manifest: VideoProjectManifest, seconds: unknown): number {
  if (seconds === undefined || seconds === null) return 0
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    fail('time must be a number of seconds')
  }
  if (seconds < 0) return 0
  if (seconds > manifest.duration) return manifest.duration
  return seconds
}
