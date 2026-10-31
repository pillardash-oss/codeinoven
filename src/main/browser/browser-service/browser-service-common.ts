import { type WebContents, type WebFrameMain } from 'electron'
import { type BrowserPageOwner } from './browser-types'

/**
 * Shared shapes and helpers the browser service units read.
 *
 * These are the values that describe a page rather than act on one: the shape of a
 * page a native menu was opened over, the URL a console message was logged from, and
 * the two readers that turn an address a page reported into the origin and the label
 * a person reads. They live here so a unit can use them without reaching through the
 * service, and so the rules stay the same wherever they are applied.
 */

/**
 * The page a native context menu was opened over.
 *
 * One shape covers both kinds of page the browser hosts   a tab's own page and a
 * popup window's   so one menu builder and one action set serve both: what
 * differs between them is only which page the actions act on and which tab a page
 * they open belongs to.
 */
export interface BrowserMenuPage {
  contents: WebContents
  owner: BrowserPageOwner
}

/**
 * URL of the frame that logged a console message, or null when there is none to
 * name.
 *
 * Reading the URL of a frame that is already gone throws, and a document with no
 * address of its own reports an empty one, so both edges answer null rather than
 * costing the entry it belongs to.
 */
export function consoleFrameUrl(frame: WebFrameMain | null | undefined): string | null {
  if (!frame) return null
  try {
    return frame.url.length > 0 ? frame.url : null
  } catch {
    return null
  }
}

export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'the current page'
  }
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
