import { toast } from 'svelte-sonner'
import { invoke, subscribeGuarded } from '$lib/ipc.svelte'
import { publishScreenshotShortcut } from '$lib/keymap/screenshot-shortcut'
import { showToastWarning } from '$lib/stores/app-errors.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import type { ScreenshotCapture } from '$shared/types'

/**
 * Delivery of system-wide region captures to the prompt that should receive one.
 *
 * A capture is taken by the main process while another app may own the keyboard,
 * so nothing in the renderer was part of the gesture. The composer registers
 * here as the active attachment target; a capture arriving with no composer is
 * held briefly for one to mount, and only then falls back to the clipboard.
 */

export interface ScreenshotTarget {
  /** Copy the capture into this prompt's storage and answer whether it landed. */
  attachScreenshot(path: string): Promise<boolean>
}

/** Newest registration wins, so a remounted composer is the one that receives. */
const targets: ScreenshotTarget[] = []

/** Captures waiting for a composer, or for their fallback deadline. */
let held: ScreenshotCapture[] = []
let fallbackTimer: ReturnType<typeof setTimeout> | null = null
let delivering = false

/** How long a capture waits for a composer before it is offered as a path. */
const COMPOSER_WAIT_MS = 8000

/** Register the composer that should receive captures; the cleanup unregisters. */
export function registerScreenshotTarget(target: ScreenshotTarget): () => void {
  targets.push(target)
  if (fallbackTimer) {
    clearTimeout(fallbackTimer)
    fallbackTimer = null
  }
  void deliverHeld()
  return () => {
    const index = targets.indexOf(target)
    if (index >= 0) targets.splice(index, 1)
  }
}

async function deliverOne(capture: ScreenshotCapture): Promise<boolean> {
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    try {
      if (await targets[index]!.attachScreenshot(capture.path)) return true
    } catch (error) {
      logRendererError('A screenshot could not be attached to the composer', error)
    }
  }
  return false
}

/** The composer could not take it, so the file itself stays useful: its path
 *  goes on the clipboard and the toast says where it is. */
async function offerPath(capture: ScreenshotCapture): Promise<void> {
  try {
    await invoke('clipboard:writeText', capture.path)
  } catch (error) {
    logRendererError('The screenshot path could not be copied', error)
  }
  showToastWarning('Screenshot saved, but it could not be attached to a prompt', {
    id: 'screenshot-no-composer',
    description: `The path is on your clipboard: ${capture.path}`,
    duration: 10_000
  })
}

async function deliverHeld(): Promise<void> {
  if (delivering || held.length === 0 || targets.length === 0) return
  delivering = true
  try {
    while (held.length > 0 && targets.length > 0) {
      const capture = held[0]!
      const attached = await deliverOne(capture)
      held.shift()
      if (attached) {
        // The gesture happened in another app, so the chip appearing is otherwise
        // only visible once the user comes back to this window.
        toast.success('Screenshot attached to the prompt')
      } else {
        await offerPath(capture)
      }
    }
  } finally {
    delivering = false
  }
  if (held.length > 0 && targets.length === 0) scheduleFallback()
}

function scheduleFallback(): void {
  if (fallbackTimer || held.length === 0) return
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null
    if (targets.length > 0) {
      void deliverHeld()
      return
    }
    const captures = held
    held = []
    for (const capture of captures) void offerPath(capture)
  }, COMPOSER_WAIT_MS)
}

function queue(capture: ScreenshotCapture): void {
  held.push(capture)
  if (targets.length > 0) void deliverHeld()
  else scheduleFallback()
}

async function readPending(): Promise<void> {
  try {
    const captures = await invoke('screenshot:pending')
    for (const capture of captures) queue(capture)
  } catch (error) {
    logRendererError('Screenshots taken while the window was closed could not be read', error)
  }
}

/**
 * Wire the capture channel and keep main's global chord current.
 *
 * `keysFor` is read here rather than captured, so the chord main claims is the
 * effective one each time the renderer or the main process announces it is ready.
 */
export function installScreenshotCapture(getKeys: () => readonly string[]): () => void {
  const unsubscribeCaptured = subscribeGuarded('screenshot:captured', (capture) => queue(capture))
  const unsubscribeReady = subscribeGuarded('app:featuresReady', () => {
    publishScreenshotShortcut(getKeys())
    void readPending()
  })
  publishScreenshotShortcut(getKeys())
  void readPending()
  return () => {
    unsubscribeCaptured()
    unsubscribeReady()
    if (fallbackTimer) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }
}
