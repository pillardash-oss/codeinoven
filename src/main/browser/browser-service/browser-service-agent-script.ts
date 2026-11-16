import { type WebContents, type WebFrameMain } from 'electron'
import { browserActionTargetScript, type BrowserActionTarget } from './browser-action-policy'
import {
  agentCursorScript,
  agentDomClickScript,
  agentElementPointScript,
  agentElementRectScript,
  agentPageOffsetScript,
  agentViewportScript,
  AGENT_REF_ATTRIBUTE
} from './browser-agent-page'
import {
  agentFrameEntries,
  agentFrameOffset,
  agentRefFrameIndex,
  type AgentFrameEntry
} from './browser-agent-frames'
import { agentCount, normalizeAgentModifiers, sendAgentMouse } from './browser-agent-input'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import type { BrowserService } from '../browser-service'
import { MAX_TRANSPORT_ERROR_LENGTH } from './browser-validation'
import { asObject } from './browser-service-common'

/**
 * The page-side helpers every agent operation shares.
 *
 * Selectors, numbers, points, hit tests and the cursor a person watches move: all of
 * it is page script driven from here, with the argument rules enforced on this side
 * of the boundary rather than trusted from the other side.
 *
 * A page is more than one document, so every helper here takes the document it
 * addresses. A reference says which one it came from (`f2r7`), and a point measured
 * inside a frame is translated into the page's own viewport before an input event
 * carries it, because that is the only space the browser delivers to.
 */

/**
 * What the page-script unit reads off the browser service.
 *
 * The agent's cursor is the app's own mark, so its appearance belongs to the service
 * that knows the theme and the UI scale, not to the script that draws it.
 */
export interface AgentScriptHost {
  readonly agentCursorAppearance: BrowserService['agentCursorAppearance']
}

/** The element an action addresses, and the document that holds it. */
export interface AgentTarget {
  selector: string
  entry: AgentFrameEntry
}

/** A point an action addresses, in the page's viewport and inside its document. */
export interface AgentPoint {
  x: number
  y: number
  localX: number
  localY: number
  entry: AgentFrameEntry
}

export class BrowserServiceAgentScript {
  constructor(private readonly host: AgentScriptHost) {}

  /**
   * Run one page-side expression, with a readable failure.
   *
   * `executeJavaScript` rejects with the page's own exception text, which is
   * useless to a model unless it is told what it was trying to do. A page that has
   * already navigated away rejects too, and that is a real answer rather than a
   * crash of the whole turn.
   */
  async runAgentScript(contents: WebContents, script: string): Promise<unknown> {
    if (contents.isDestroyed()) throw new Error('The browser page is no longer available')
    try {
      return await contents.executeJavaScript(script)
    } catch (error) {
      throw this.readFailure(error)
    }
  }

  /**
   * Run one page-side expression in a specific document of the page.
   *
   * The page's own document goes through `webContents` exactly as before. Any
   * other document is addressed through its frame, which is how a control inside
   * an embedded blade becomes readable at all.
   */
  async runAgentScriptIn(entry: AgentFrameEntry, script: string): Promise<unknown> {
    if (entry.index === 0) {
      const main = entry.frame
      if (main.detached) throw new Error('The browser page is no longer available')
      return this.runInFrame(main, script)
    }
    return this.runInFrame(entry.frame, script)
  }

  private async runInFrame(frame: WebFrameMain, script: string): Promise<unknown> {
    if (frame.detached) throw new Error('That frame of the page is no longer there')
    try {
      return await frame.executeJavaScript(script)
    } catch (error) {
      throw this.readFailure(error)
    }
  }

  private readFailure(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(
      `The page could not be read: ${message.slice(0, MAX_TRANSPORT_ERROR_LENGTH)}`,
      {
        cause: error
      }
    )
  }

  /**
   * The element an action addresses: a snapshot reference, or a CSS selector.
   *
   * A reference is an attribute the page carries, so it is turned into a selector
   * here and every later step works on a selector alone. That keeps one code path
   * for both spellings, and a reference the page no longer has simply fails to
   * resolve instead of acting on something else.
   */
  agentSelector(input: Record<string, unknown>): string {
    const reference = input['ref']
    if (reference !== undefined) {
      if (typeof reference !== 'string') {
        throw new TypeError(
          'ref must be the reference string a snapshot reported, such as "r12" or "f2r7"'
        )
      }
      const trimmed = reference.trim()
      if (agentRefFrameIndex(trimmed) === null) {
        throw new TypeError('ref must be a reference a snapshot reported, such as "r12" or "f2r7"')
      }
      return `[${AGENT_REF_ATTRIBUTE}="${trimmed}"]`
    }
    if (input['selector'] === undefined) {
      throw new TypeError('name the element to act on with ref (from a snapshot) or selector')
    }
    return this.requiredInputString(input, 'selector')
  }

  /** The element an optional action addresses, when it may address the page itself. */
  optionalAgentSelector(input: Record<string, unknown>): string | undefined {
    if (input['ref'] === undefined && input['selector'] === undefined) return undefined
    return this.agentSelector(input)
  }

  /**
   * The document an action addresses.
   *
   * A reference already names its frame, so nothing else is needed for the common
   * case. A bare CSS selector names a document with `frame`, and the page's own
   * document is the default, which keeps every existing call working.
   */
  agentEntry(input: Record<string, unknown>, contents: WebContents): AgentFrameEntry {
    const entries = agentFrameEntries(contents)
    const reference = typeof input['ref'] === 'string' ? input['ref'].trim() : ''
    const fromRef = reference ? agentRefFrameIndex(reference) : null
    const declared = input['frame']
    if (fromRef === null && declared !== undefined) {
      if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
        throw new TypeError('frame must be the frame number a snapshot reported, such as 2')
      }
    }
    const index = fromRef ?? (typeof declared === 'number' ? declared : 0)
    const entry = entries[index]
    if (!entry) {
      throw new Error(
        `The page has no frame ${index}. A snapshot lists every frame it read, and a reference from one of them works on its own.`
      )
    }
    return entry
  }

  /** The element and document an action addresses. */
  agentTarget(input: Record<string, unknown>, contents: WebContents): AgentTarget {
    const entry = this.agentEntry(input, contents)
    return { selector: this.agentSelector(input), entry }
  }

  /** The element and document an optional action addresses, when it names one. */
  optionalAgentTarget(
    input: Record<string, unknown>,
    contents: WebContents
  ): AgentTarget | undefined {
    if (input['ref'] === undefined && input['selector'] === undefined) return undefined
    return this.agentTarget(input, contents)
  }

  /** A whole number from tool input, clamped, with a default for an absent field. */
  agentBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(Math.round(value), max))
  }

  /** A signed offset from tool input, clamped to what a page could plausibly scroll. */
  agentSignedNumber(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(-20000, Math.min(Math.round(value), 20000))
  }

  /**
   * Where an element is, in the page's viewport and inside its own document.
   *
   * A frame is drawn at an inset inside every parent above it, so a point the
   * frame reports has to travel back up that chain before the browser's input
   * pipeline can reach it. When the chain cannot be measured the call says so
   * rather than clicking a point that means nothing.
   */
  async pointFor(tab: BrowserTab, target: AgentTarget): Promise<AgentPoint> {
    const contents = tab.view.webContents
    const described = asObject(
      await this.runAgentScriptIn(target.entry, agentElementPointScript(target.selector))
    )
    if (described?.['found'] !== true) {
      throw new Error(
        `The element could not be reached: ${String(described?.['reason'] ?? 'not found')}`
      )
    }
    const localX = Math.round(Number(described['x']))
    const localY = Math.round(Number(described['y']))
    if (target.entry.index === 0) {
      return { x: localX, y: localY, localX, localY, entry: target.entry }
    }
    const offset = await agentFrameOffset(target.entry, contents.mainFrame, (frame, script) =>
      frame.executeJavaScript(script)
    )
    if (!offset) {
      throw new Error(
        `The element is inside frame ${target.entry.index}, and that frame could not be measured on screen, so a pointer click would miss it. Act on it by ref anyway: a click falls back to the element's own click, and type, select, check, scroll and evaluate work inside the frame directly.`
      )
    }
    return {
      x: localX + offset.x,
      y: localY + offset.y,
      localX,
      localY,
      entry: target.entry
    }
  }

  /**
   * The element's rectangle in the page's own coordinates, for an element capture.
   *
   * An element screenshot is clipped in the document's coordinates, and an element
   * inside a frame lives in another document: its rectangle is measured there, then
   * carried out through every parent's inset and the page's own scroll, so the clip
   * lands on the element instead of on the top document's version of that number.
   * `null` means the element, its frame, or the chain around it could not be
   * measured, and the caller captures the viewport instead.
   */
  async pageRectFor(
    tab: BrowserTab,
    target: AgentTarget
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const described = asObject(
      await this.runAgentScriptIn(target.entry, agentElementRectScript(target.selector))
    )
    if (!described) return null
    const width = Number(described['width'])
    const height = Number(described['height'])
    if (!(width > 0) || !(height > 0)) return null
    let x = Number(described['x'])
    let y = Number(described['y'])
    if (target.entry.index !== 0) {
      const offset = await agentFrameOffset(
        target.entry,
        tab.view.webContents.mainFrame,
        (frame, script) => frame.executeJavaScript(script)
      )
      if (!offset) return null
      const scroll = asObject(
        await this.runAgentScript(tab.view.webContents, agentPageOffsetScript()).catch(() => null)
      )
      x += offset.x + Number(scroll?.['x'] ?? 0)
      y += offset.y + Number(scroll?.['y'] ?? 0)
    }
    return { x, y, width, height }
  }

  /**
   * The point an action addresses: an element's centre, or explicit coordinates.
   *
   * Resolving an element to a point is what lets a click arrive as a pointer click
   * instead of a DOM call, so the page's hover, focus, caret and pointer handlers
   * all run exactly as they would for a person.
   */
  async agentPointFrom(
    input: Record<string, unknown>,
    tab: BrowserTab,
    label: 'point' | 'from' | 'to'
  ): Promise<AgentPoint> {
    const source = label === 'point' ? input : asObject(input[label])
    if (!source)
      throw new TypeError(`${label} must carry x and y, or a selector/ref naming an element`)
    const target = this.optionalAgentTarget(source, tab.view.webContents)
    if (target) return this.pointFor(tab, target)
    const entry = this.agentEntry(source, tab.view.webContents)
    const x = source['x']
    const y = source['y']
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new TypeError(`${label} needs numeric x and y, or a selector/ref naming an element`)
    }
    const localX = Math.round(x)
    const localY = Math.round(y)
    if (entry.index === 0) return { x: localX, y: localY, localX, localY, entry }
    const offset = await agentFrameOffset(entry, tab.view.webContents.mainFrame, (frame, script) =>
      frame.executeJavaScript(script)
    )
    if (!offset) {
      throw new Error(
        `Frame ${entry.index} could not be measured on screen, so a point inside it cannot be clicked. Aim at an element with ref instead.`
      )
    }
    return {
      x: localX + offset.x,
      y: localY + offset.y,
      localX,
      localY,
      entry
    }
  }

  /** Whether the element an approval was granted for has changed since. */
  async agentTargetChanged(
    target: AgentTarget,
    reviewedTarget: BrowserActionTarget | null
  ): Promise<boolean> {
    if (!reviewedTarget) return false
    const current = await this.runAgentScriptIn(
      target.entry,
      browserActionTargetScript(target.selector)
    )
    return JSON.stringify(current) !== JSON.stringify(reviewedTarget)
  }

  /**
   * Click an element the way a pointer does, and say which way it landed.
   *
   * The pointer path is the real one: a move, a press and a release at the centre
   * of the element, which is the sequence Chromium turns into a trusted click. An
   * element a pointer cannot reach (hidden, or covered by an overlay) falls back to
   * its own `click()`, reported as `via: "dom"` so a caller knows the difference.
   */
  async clickAgentTarget(
    tab: BrowserTab,
    target: AgentTarget,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const contents = tab.view.webContents
    const clickCount = agentCount(input['clickCount'], 1, 3)
    const modifiers = normalizeAgentModifiers(input['modifiers'])
    const reachable = asObject(
      await this.runAgentScriptIn(target.entry, agentElementPointScript(target.selector))
    )
    if (reachable?.['found'] === true && reachable['coveredBy'] === null) {
      const point = await this.pointFor(tab, target).catch(() => null)
      if (point) {
        const visible = await this.pointIsInViewport(tab, point)
        if (visible) {
          await sendAgentMouse(contents, {
            action: 'click',
            x: point.x,
            y: point.y,
            clickCount,
            modifiers
          })
          await this.paintAgentCursor(tab, { x: point.x, y: point.y })
          return {
            clicked: true,
            via: 'pointer',
            x: point.x,
            y: point.y,
            clickCount,
            ...(target.entry.index === 0 ? {} : { frame: target.entry.index })
          }
        }
      }
    }
    const fallback =
      asObject(await this.runAgentScriptIn(target.entry, agentDomClickScript(target.selector))) ??
      {}
    return {
      ...fallback,
      via: 'dom',
      ...(target.entry.index === 0 ? {} : { frame: target.entry.index }),
      ...(reachable?.['reason'] === undefined ? {} : { pointer: reachable['reason'] })
    }
  }

  /** Whether a point falls inside the part of the page the browser shows. */
  private async pointIsInViewport(tab: BrowserTab, point: AgentPoint): Promise<boolean> {
    if (point.entry.index === 0) return true
    const viewport = asObject(
      await this.runAgentScript(tab.view.webContents, agentViewportScript())
    )
    const width = Number(viewport?.['width'] ?? 0)
    const height = Number(viewport?.['height'] ?? 0)
    if (width <= 0 || height <= 0) return true
    return point.x >= 0 && point.y >= 0 && point.x < width && point.y < height
  }

  /** Draw the agent's own pointer at a point, so a capture shows where it acted. */
  async paintAgentCursor(tab: BrowserTab, point: { x: number; y: number }): Promise<void> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    try {
      await contents.executeJavaScript(
        agentCursorScript({
          x: Math.round(point.x),
          y: Math.round(point.y),
          hide: false,
          appearance: await this.host.agentCursorAppearance()
        })
      )
    } catch (error) {
      Logger.dev('The agent cursor overlay could not be drawn:', error)
    }
  }

  /** Draw the agent's pointer on an element, when the element can be measured. */
  async paintAgentCursorAtElement(tab: BrowserTab, target: AgentTarget): Promise<void> {
    const point = await this.pointFor(tab, target).catch(() => null)
    if (!point) return
    await this.paintAgentCursor(tab, { x: point.x, y: point.y })
  }

  requiredInputString(input: Record<string, unknown>, field: string, allowEmpty = false): string {
    const value = input[field]
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 8192) {
      throw new TypeError(`${field} must be a string${allowEmpty ? '' : ' with content'}`)
    }
    return value
  }
}
