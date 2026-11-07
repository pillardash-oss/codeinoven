import { BrowserWindow } from 'electron'
import type { DesignScreen } from '../../lib/ipc/design'
import type { ScreenCanvasDiscoveredState } from '../../lib/design/screen-canvas'
import { Logger } from '../system/logger'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { resolveServedEntry, servedFileUrl } from '../preview/served-folder'
import { designStatesScript } from './design-states-script'
import { hasScreenStates, rememberScreenStates } from './design-states-registry'

/**
 * The states a design's screens declare, discovered once per version of the design.
 *
 * A canvas can already draw a state: a frame carries the click that reaches it and
 * the runtime performs it inside the frame. What nothing could say is which states
 * exist, and a design's author having to write each one into `canvas.json` is a
 * page that falls behind the screens it describes. So the folder is read directly:
 * each screen is loaded in a hidden window, its own markup is asked which triggers
 * declare a state, and the answer is remembered against the design's stamp.
 *
 * Three properties make that safe to run on the board's own schedule.
 *
 * It is a read. Nothing in discovery clicks, types or navigates beyond loading the
 * screen, so a state can never be half-applied and a design can never be changed
 * by being looked at. It is a separate window with its own partition, so the
 * reader's tab, cookies and scroll position are not involved and a screen that
 * misbehaves cannot reach the browser the user is working in. And it is memoized
 * against the newest write in the folder, so a design is read once per version of
 * itself rather than once per board refresh, and a screen the agent just rewrote is
 * read again on the next board paint.
 *
 * The canvas page asks the registry synchronously while it is being
 * generated: a design whose states have not been discovered yet is framed exactly
 * as it was before, and gains its state frames on the next page load. That is why
 * discovery is started by the board's reads rather than by the paint itself.
 */

/** Wall-clock budget for reading one design's screens, on top of per-screen loads. */
const DISCOVERY_BUDGET_MS = 20_000

/** How long one screen is given to load before it is read as it is. */
const SCREEN_LOAD_TIMEOUT_MS = 6_000

/** Most screens one discovery pass reads, matching the board's own listing cap. */
const MAX_DISCOVERY_SCREENS = 24

const running = new Map<string, { stamp: number; task: Promise<void> }>()

/**
 * Discovery runs one design at a time.
 *
 * Each pass owns a hidden window and loads every screen of a design, so two boards
 * opening at once would otherwise multiply page loads for no extra answer. A
 * second request waits for the first and then finds its record already written.
 */
let queue: Promise<void> = Promise.resolve()

/**
 * Read this design's states if they are not known yet.
 *
 * Never throws and never awaited by a caller on a request path: a design that
 * cannot be read is a design with no discovered states, which is the canvas
 * exactly as it was before this existed.
 */
export function ensureScreenStates(input: {
  folderAbsolute: string
  stamp: number
  screens: readonly DesignScreen[]
  previews: DirectoryPreviewService
}): void {
  if (input.screens.length === 0) return
  const current = running.get(input.folderAbsolute)
  if (current && current.stamp === input.stamp) return
  if (hasScreenStates(input.folderAbsolute, input.stamp)) return
  const task = queue
    .then(() => discover(input))
    .then((states) => {
      rememberScreenStates(input.folderAbsolute, input.stamp, states)
    })
    .catch((error: unknown) => {
      // A screen that will not load is a state the canvas does not show, never a
      // board that fails: the next version of the design is read again.
      Logger.dev('Design states could not be discovered:', error)
    })
  running.set(input.folderAbsolute, { stamp: input.stamp, task })
  queue = task
  void task.finally(() => {
    if (running.get(input.folderAbsolute)?.task === task) running.delete(input.folderAbsolute)
  })
}

/** Load every screen once and collect the states its markup declares. */
async function discover(input: {
  folderAbsolute: string
  screens: readonly DesignScreen[]
  previews: DirectoryPreviewService
}): Promise<ScreenCanvasDiscoveredState[]> {
  const registration = await input.previews.open(input.folderAbsolute)
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Its own partition: discovery may not read, write or even see the profile
      // the reader's own tabs are using.
      partition: 'design-states-discovery'
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const startedAt = Date.now()
  const states: ScreenCanvasDiscoveredState[] = []
  try {
    for (const screen of input.screens.slice(0, MAX_DISCOVERY_SCREENS)) {
      if (Date.now() - startedAt >= DISCOVERY_BUDGET_MS) break
      const resolved = await resolveServedEntry(input.folderAbsolute, screen.entry).catch(
        () => null
      )
      if (resolved === null) continue
      const loaded = await withTimeout(
        window.loadURL(servedFileUrl(registration.url, resolved)),
        SCREEN_LOAD_TIMEOUT_MS
      ).catch(() => false)
      if (!loaded) continue
      const found: unknown = await window.webContents
        .executeJavaScript(designStatesScript(), false)
        .catch(() => null)
      if (!Array.isArray(found)) continue
      for (const item of found) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as { click?: unknown; title?: unknown }
        if (typeof record.click !== 'string' || record.click.length === 0) continue
        states.push({
          entry: screen.entry,
          click: record.click.slice(0, 300),
          title: typeof record.title === 'string' ? record.title.slice(0, 80) : null
        })
      }
    }
  } finally {
    window.destroy()
  }
  return states
}

/** Resolve true when the promise settles in time, false when it does not. */
async function withTimeout(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
