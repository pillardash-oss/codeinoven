import { type WebContents } from 'electron'
import { browserActionTargetScript, type BrowserActionTarget } from './browser-action-policy'
import {
  agentCursorScript,
  agentDomClickScript,
  agentElementPointScript,
  AGENT_REF_ATTRIBUTE
} from './browser-agent-page'
import { agentCount, normalizeAgentModifiers, sendAgentMouse } from './browser-agent-input'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import { MAX_TRANSPORT_ERROR_LENGTH } from './browser-validation'
import { asObject } from './browser-service-common'

/**
 * The page-side helpers every agent operation shares.
 *
 * Selectors, numbers, points, hit tests and the cursor a person watches move: all of
 * it is page script driven from here, with the argument rules enforced on this side
 * of the boundary rather than trusted from the other side.
 */

export class BrowserServiceAgentScript {
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
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `The page could not be read: ${message.slice(0, MAX_TRANSPORT_ERROR_LENGTH)}`,
        { cause: error }
      )
    }
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
        throw new TypeError('ref must be the reference string a snapshot reported, such as "r12"')
      }
      const trimmed = reference.trim()
      if (!/^r\d{1,6}$/u.test(trimmed)) {
        throw new TypeError('ref must be a reference a snapshot reported, such as "r12"')
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
  ): Promise<{ x: number; y: number }> {
    const source = label === 'point' ? input : asObject(input[label])
    if (!source)
      throw new TypeError(`${label} must carry x and y, or a selector/ref naming an element`)
    const selector = this.optionalAgentSelector(source)
    if (selector) {
      const described = asObject(
        await this.runAgentScript(tab.view.webContents, agentElementPointScript(selector))
      )
      if (described?.['found'] !== true) {
        throw new Error(
          `The element could not be reached: ${String(described?.['reason'] ?? 'not found')}`
        )
      }
      return { x: Math.round(Number(described['x'])), y: Math.round(Number(described['y'])) }
    }
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
    return { x: Math.round(x), y: Math.round(y) }
  }

  /** Whether the element an approval was granted for has changed since. */
  async agentTargetChanged(
    contents: WebContents,
    selector: string,
    reviewedTarget: BrowserActionTarget | null
  ): Promise<boolean> {
    if (!reviewedTarget) return false
    const current = await contents.executeJavaScript(browserActionTargetScript(selector))
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
    selector: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const contents = tab.view.webContents
    const clickCount = agentCount(input['clickCount'], 1, 3)
    const modifiers = normalizeAgentModifiers(input['modifiers'])
    const point = asObject(await this.runAgentScript(contents, agentElementPointScript(selector)))
    if (point?.['found'] === true && point['coveredBy'] === null) {
      const x = Math.round(Number(point['x']))
      const y = Math.round(Number(point['y']))
      await sendAgentMouse(contents, { action: 'click', x, y, clickCount, modifiers })
      await this.paintAgentCursor(tab, { x, y }, true)
      return { clicked: true, via: 'pointer', x, y, clickCount }
    }
    const fallback =
      asObject(await this.runAgentScript(contents, agentDomClickScript(selector))) ?? {}
    return {
      ...fallback,
      via: 'dom',
      ...(point?.['reason'] === undefined ? {} : { pointer: point['reason'] })
    }
  }

  /** Draw the agent's own pointer at a point, so a capture shows where it acted. */
  async paintAgentCursor(
    tab: BrowserTab,
    point: { x: number; y: number },
    press: boolean
  ): Promise<void> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    try {
      await contents.executeJavaScript(
        agentCursorScript({ x: Math.round(point.x), y: Math.round(point.y), press, hide: false })
      )
    } catch (error) {
      Logger.dev('The agent cursor overlay could not be drawn:', error)
    }
  }

  /** Draw the agent's pointer on an element, when the element can be measured. */
  async paintAgentCursorAtElement(
    tab: BrowserTab,
    selector: string,
    press: boolean
  ): Promise<void> {
    const described = asObject(
      await this.runAgentScript(tab.view.webContents, agentElementPointScript(selector)).catch(
        () => null
      )
    )
    if (described?.['found'] !== true) return
    await this.paintAgentCursor(
      tab,
      { x: Number(described['x']), y: Number(described['y']) },
      press
    )
  }

  requiredInputString(input: Record<string, unknown>, field: string, allowEmpty = false): string {
    const value = input[field]
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 8192) {
      throw new TypeError(`${field} must be a string${allowEmpty ? '' : ' with content'}`)
    }
    return value
  }
}
