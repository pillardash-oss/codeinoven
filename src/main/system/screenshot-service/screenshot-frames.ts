import { desktopCapturer, screen, type Display, type NativeImage } from 'electron'

/** A still of every display, taken before any overlay can appear in one. */

const FRAME_TIMEOUT_MS = 10_000

export interface DisplayFrame {
  display: Display
  image: NativeImage
}

async function screenSources(
  width: number,
  height: number
): Promise<Electron.DesktopCapturerSource[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('The screen did not answer in time.')),
      FRAME_TIMEOUT_MS
    )
  })
  try {
    return await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } }),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function captureDisplayFrames(): Promise<DisplayFrame[]> {
  const displays = screen.getAllDisplays()
  // `thumbnailSize` applies to every source of a call, so monitors that share a
  // native size share a call, and the calls run one after another.
  const bySize = new Map<string, Electron.DesktopCapturerSource[]>()
  const frames: DisplayFrame[] = []
  for (const [index, display] of displays.entries()) {
    const width = Math.round(display.size.width * display.scaleFactor)
    const height = Math.round(display.size.height * display.scaleFactor)
    const key = `${width}x${height}`
    let sources = bySize.get(key)
    if (!sources) {
      sources = await screenSources(width, height)
      bySize.set(key, sources)
    }
    const source =
      sources.find((candidate) => candidate.display_id === String(display.id)) ??
      // Some X servers name no display. Position is a safe match only when there
      // is exactly one source per display.
      (sources.length === displays.length && sources.every((candidate) => !candidate.display_id)
        ? sources[index]
        : undefined)
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error(`Display ${index + 1} of ${displays.length} could not be captured.`)
    }
    frames.push({ display, image: source.thumbnail })
  }
  if (frames.length === 0) throw new Error('No display was found to capture.')
  return frames
}
