import type { WebContents } from 'electron'
import { Logger } from '../../system/logger'

/**
 * The size an extension's own popup asked for, measured from its document.
 *
 * A browser sizes an action popup to the content the extension draws, and the
 * extension decides that size itself: it sets a width on its body, or lets its own
 * layout grow it. Nothing outside the document can know that size, so the only
 * honest answer is to measure the document once it has laid out and hand the result
 * to whichever chrome is hosting the popup.
 *
 * The bounds are Chrome's own: a popup narrower or shorter than 25 px is a mistake
 * no extension means, and 800 by 600 is as large as an action popup may get.
 */

/** The smallest popup a measurement may report, in density-independent pixels. */
export const EXTENSION_POPUP_MIN_SIZE = 25

/** Chrome's own ceiling for an action popup's width. */
export const EXTENSION_POPUP_MAX_WIDTH = 800

/** Chrome's own ceiling for an action popup's height. */
export const EXTENSION_POPUP_MAX_HEIGHT = 600

/**
 * Measure the document in the largest box it actually draws.
 *
 * Both the document element and the body are read, because an extension that
 * styles one and not the other is common, and the larger of the two is the box the
 * content really occupies. Every read is a layout value, so nothing here changes
 * what the page draws.
 */
const MEASURE_SCRIPT = `(() => {
  const doc = document.documentElement
  const body = document.body
  return {
    width: Math.max(
      doc ? doc.scrollWidth : 0,
      body ? Math.max(body.scrollWidth, body.offsetWidth) : 0
    ),
    height: Math.max(
      doc ? doc.scrollHeight : 0,
      body ? Math.max(body.scrollHeight, body.offsetHeight) : 0
    )
  }
})()`

/** One measured size, already clamped to what a popup may be. */
export interface ExtensionPopupSize {
  width: number
  height: number
}

function clampExtent(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.ceil(value)
  if (rounded <= 0) return null
  return Math.min(max, Math.max(EXTENSION_POPUP_MIN_SIZE, rounded))
}

/**
 * Measure one extension popup's page, or answer null when its document cannot be
 * read or reports nothing usable.
 *
 * The script runs against whatever document is in the page when it runs, so the
 * caller's own checks are what keep an answer about a page that has since navigated
 * from being applied.
 */
export async function measureExtensionPopupSize(
  page: WebContents
): Promise<ExtensionPopupSize | null> {
  if (page.isDestroyed()) return null
  let raw: unknown
  try {
    raw = await page.executeJavaScript(MEASURE_SCRIPT, false)
  } catch (error: unknown) {
    Logger.dev('An extension popup could not be measured:', error)
    return null
  }
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  if (!record) return null
  const width = clampExtent(record['width'], EXTENSION_POPUP_MAX_WIDTH)
  const height = clampExtent(record['height'], EXTENSION_POPUP_MAX_HEIGHT)
  if (width === null || height === null) return null
  return { width, height }
}
