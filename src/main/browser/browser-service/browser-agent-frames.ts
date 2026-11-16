import type { WebContents, WebFrameMain } from 'electron'
import {
  agentFrameRectsScript,
  agentFrameRevealScript,
  type AgentFrameRect
} from './browser-agent-page'
import { asObject } from './browser-service-common'

/**
 * The documents one page is made of, and where each one sits.
 *
 * A page is not one document. A portal renders each blade in its own frame, a
 * payment flow hands the card form to the processor's frame, and a chat widget
 * lives in a frame of its own. Reading only the top document therefore reported
 * "only the title" on the page an agent was sent to operate, and every click it
 * aimed at a control it could not see missed: this module is what lets the agent
 * read and act inside the document that actually holds the control.
 *
 * Two rules make it work. A reference carries the frame it came from (`f2r7`), so
 * one handle is unambiguous without a second argument. And a point measured in a
 * frame is translated through every parent's own inset into the page's viewport,
 * which is the one coordinate space the browser's input pipeline delivers to.
 */

/** Frames a snapshot reads, so a page with fifty of them stays one call. */
export const MAX_AGENT_FRAMES = 12
/** Frames deep a reference is followed, in case a page nests documents in a loop. */
export const MAX_AGENT_FRAME_DEPTH = 8

/** One document an agent may read or act in. */
export interface AgentFrameEntry {
  /** Position in the frame list the snapshot reports; 0 is the page's own document. */
  index: number
  frame: WebFrameMain
  url: string
  name: string
  /** The prefix every reference from this document carries, empty for the main one. */
  refPrefix: string
}

/** The prefix a frame's references carry, so a ref alone names its document. */
export function agentFrameRefPrefix(index: number): string {
  return index === 0 ? '' : `f${index}`
}

const AGENT_REF = /^r\d{1,6}$/u
const AGENT_FRAME_REF = /^f(\d{1,3})r\d{1,6}$/u

/**
 * The frame a snapshot reference belongs to.
 *
 * A plain `r7` is the page's own document, which is what every reference meant
 * before frames were readable. A namespaced `f2r7` names frame 2, and `null` is a
 * string that is not a reference at all.
 */
export function agentRefFrameIndex(ref: string): number | null {
  if (AGENT_REF.test(ref)) return 0
  const match = AGENT_FRAME_REF.exec(ref)
  return match ? Number(match[1]) : null
}

function frameUrl(frame: WebFrameMain): string {
  try {
    return frame.url
  } catch {
    return ''
  }
}

function frameDepth(frame: WebFrameMain, main: WebFrameMain): number {
  let depth = 0
  let current: WebFrameMain | null = frame
  while (current && current !== main && depth <= MAX_AGENT_FRAME_DEPTH) {
    current = current.parent
    depth += 1
  }
  return depth
}

/**
 * Every document this page is made of, in the order a snapshot reports them.
 *
 * The page's own document is always index 0, and the rest follow in the browser's
 * own pre-order, so the list is stable for as long as the page is. Frames beyond
 * {@link MAX_AGENT_FRAMES} and frames nested deeper than
 * {@link MAX_AGENT_FRAME_DEPTH} are left out: an advert-heavy page must not turn
 * one snapshot into fifty round trips.
 */
export function agentFrameEntries(contents: WebContents): AgentFrameEntry[] {
  const main = contents.mainFrame
  const entries: AgentFrameEntry[] = []
  for (const frame of main.framesInSubtree) {
    if (entries.length >= MAX_AGENT_FRAMES) break
    if (frame !== main && frame.detached) continue
    if (frameDepth(frame, main) >= MAX_AGENT_FRAME_DEPTH) continue
    entries.push({
      index: entries.length,
      frame,
      url: frameUrl(frame),
      name: safeFrameName(frame),
      refPrefix: agentFrameRefPrefix(entries.length)
    })
  }
  if (entries.length === 0) {
    entries.push({ index: 0, frame: main, url: frameUrl(main), name: '', refPrefix: '' })
  }
  return entries
}

function safeFrameName(frame: WebFrameMain): string {
  try {
    return frame.name ?? ''
  } catch {
    return ''
  }
}

/** The frame a snapshot index names, or `null` when the page no longer has it. */
export function agentFrameAt(contents: WebContents, index: number): AgentFrameEntry | null {
  if (!Number.isInteger(index) || index < 0) return null
  return agentFrameEntries(contents)[index] ?? null
}

/** Run one page script in a specific document of the page. */
export type RunFrameScript = (frame: WebFrameMain, script: string) => Promise<unknown>

function rectOf(value: unknown): AgentFrameRect | null {
  const record = asObject(value)
  if (!record) return null
  const fields = ['x', 'y', 'width', 'height'] as const
  if (fields.some((field) => typeof record[field] !== 'number')) return null
  return {
    index: typeof record['index'] === 'number' ? record['index'] : 0,
    x: Number(record['x']),
    y: Number(record['y']),
    width: Number(record['width']),
    height: Number(record['height']),
    src: typeof record['src'] === 'string' ? record['src'] : '',
    title: typeof record['title'] === 'string' ? record['title'] : ''
  }
}

function rectList(value: unknown): AgentFrameRect[] {
  if (!Array.isArray(value)) return []
  return value.map(rectOf).filter((rect): rect is AgentFrameRect => rect !== null)
}

/**
 * Which frame element of the parent hosts this child.
 *
 * The child's own address is the identity: a parent publishes each frame
 * element's resolved `src`, and a child frame reports the address it actually
 * loaded. When a page rewrites addresses so nothing matches (a `srcdoc` frame, a
 * redirected embed) the document order is the fallback, and it is only trusted
 * when the parent's element count and the browser's child count agree.
 */
export function matchFrameRect(
  rects: AgentFrameRect[],
  child: WebFrameMain,
  parent: WebFrameMain
): AgentFrameRect | null {
  const url = frameUrl(child)
  if (url) {
    const byUrl = rects.filter((rect) => rect.src === url)
    if (byUrl.length === 1) return byUrl[0]
  }
  const index = parent.frames.indexOf(child)
  if (index >= 0 && rects.length === parent.frames.length) return rects[index] ?? null
  return null
}

/**
 * Where a frame sits in the page's own viewport, in viewport coordinates.
 *
 * Each step is measured by the parent, because that is the only side that can see
 * the frame element at all, and the frame is scrolled into view on the way so the
 * point that comes out is a point the pointer can actually reach. `null` means the
 * chain could not be measured, and an action then falls back to the frame's own
 * DOM click instead of guessing at a pixel.
 */
export async function agentFrameOffset(
  entry: AgentFrameEntry,
  main: WebFrameMain,
  run: RunFrameScript
): Promise<{ x: number; y: number } | null> {
  let x = 0
  let y = 0
  let current: WebFrameMain | null = entry.frame
  let steps = 0
  while (current && current !== main) {
    if (steps >= MAX_AGENT_FRAME_DEPTH) return null
    steps += 1
    const parent: WebFrameMain | null = current.parent
    if (!parent) return null
    const rects = rectList(await run(parent, agentFrameRectsScript()).catch(() => null))
    const rect = matchFrameRect(rects, current, parent)
    if (!rect) return null
    const revealed = rectOf(await run(parent, agentFrameRevealScript(rect.index)).catch(() => null))
    if (!revealed || revealed.width <= 0 || revealed.height <= 0) return null
    x += revealed.x
    y += revealed.y
    current = parent
  }
  return { x, y }
}
