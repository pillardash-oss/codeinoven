import type { PermissionLevel } from '../../../lib/types'
import {
  browserActionTargetScript,
  reviewBrowserAction,
  type BrowserActionTarget
} from './browser-action-policy'
import {
  agentCheckScript,
  agentEvaluateScript,
  agentFocusScript,
  agentHitTestScript,
  agentScrollScript,
  agentSelectScript,
  agentSnapshotScript,
  agentTypeScript,
  agentWaitScript
} from './browser-agent-page'
import {
  agentCount,
  dragAgentMouse,
  normalizeAgentModifiers,
  pressAgentKey,
  sendAgentMouse
} from './browser-agent-input'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { type BrowserTab } from './browser-types'
import {
  DEFAULT_PARKED_VIEWPORT,
  browserContextKey,
  validateAttention,
  validateBrowserUrl,
  validateProjectId,
  validateThreadId,
  validateUtilityPage,
  validateViewportRequest
} from './browser-validation'
import type { BrowserService } from '../browser-service'
import { asObject, safeOrigin } from './browser-service-common'
import { liveContents } from './browser-view-contents'
import {
  ATTACHED_PAGE_MUTATION_OPERATIONS,
  ATTACHED_PAGE_READ_OPERATIONS
} from './browser-service-agent-approval'

/**
 * The browser capability an agent drives.
 *
 * One entry point takes the operation an agent asked for and runs it against a tab's
 * page: reading operations observe the document, mutations pass through action-aware
 * Auto Review or the thread's permission card first. This unit owns the operation
 * switch, the approval path, and the sentence a person reads on the card.
 */

/**
 * What `browser-service-agent-utility` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface AgentUtilityHost {
  readonly activeTabId: BrowserService['activeTabId']
  readonly agentActionApprover: BrowserService['agentActionApprover']
  readonly agentBoundedNumber: BrowserService['agentBoundedNumber']
  readonly agentPointFrom: BrowserService['agentPointFrom']
  readonly agentSelector: BrowserService['agentSelector']
  readonly agentSignedNumber: BrowserService['agentSignedNumber']
  readonly agentTabIds: BrowserService['agentTabIds']
  readonly agentTargetChanged: BrowserService['agentTargetChanged']
  readonly assistantPageTabIds: BrowserService['assistantPageTabIds']
  readonly captureScreenshot: BrowserService['captureScreenshot']
  readonly clickAgentTarget: BrowserService['clickAgentTarget']
  readonly conversationScope: BrowserService['conversationScope']
  readonly ensureTab: BrowserService['ensureTab']
  readonly isRelaxed: BrowserService['isRelaxed']
  readonly load: BrowserService['load']
  readonly optionalAgentSelector: BrowserService['optionalAgentSelector']
  readonly paintAgentCursor: BrowserService['paintAgentCursor']
  readonly paintAgentCursorAtElement: BrowserService['paintAgentCursorAtElement']
  readonly parkedViewportFor: BrowserService['parkedViewportFor']
  readonly parkTab: BrowserService['parkTab']
  readonly rememberReveal: BrowserService['rememberReveal']
  readonly requiredInputString: BrowserService['requiredInputString']
  readonly runAgentScript: BrowserService['runAgentScript']
  readonly stage: BrowserService['stage']
  readonly stateFor: BrowserService['stateFor']
  readonly threadBrowserHint: BrowserService['threadBrowserHint']
  readonly touchParkedTab: BrowserService['touchParkedTab']
  readonly uploadFiles: BrowserService['uploadFiles']
  readonly utilityTabContext: BrowserService['utilityTabContext']
  readonly utilityTarget: BrowserService['utilityTarget']
  readonly window: BrowserService['window']
}

/**
 * The control description a page script reported, as a review target.
 *
 * The shape crosses a page boundary, so it is rebuilt field by field rather than
 * trusted: a page that answers with something else yields `null`, which the review
 * treats as an unidentified control.
 */
export function asBrowserActionTarget(value: unknown): BrowserActionTarget | null {
  const record = asObject(value)
  if (!record) return null
  const text = (field: string): string => (typeof record[field] === 'string' ? record[field] : '')
  return {
    tag: text('tag'),
    type: text('type'),
    role: text('role'),
    label: text('label'),
    name: text('name'),
    href: text('href'),
    download: record['download'] === true,
    expanded: record['expanded'] === true,
    formMethod: text('formMethod'),
    formAction: text('formAction')
  }
}

export class BrowserServiceAgentUtility {
  constructor(private readonly host: AgentUtilityHost) {}

  async executeUtility(
    operation: string,
    input: Record<string, unknown>,
    context: {
      projectId: string
      threadId: string
      // Only the upload path consults this. Callers that can never upload (the
      // design and video preview sessions) omit it, and the upload fallback then
      // treats the missing level as review-required rather than full access.
      permissionLevel?: PermissionLevel
      sessionId?: string
    }
  ): Promise<unknown> {
    const projectId = validateProjectId(context.projectId)
    const threadId = validateThreadId(context.threadId)
    const contextKey = browserContextKey(projectId, threadId)
    const scope = this.host.conversationScope(projectId, threadId)
    if (operation === 'open') {
      const url = validateBrowserUrl(this.host.requiredInputString(input, 'url'))
      const attention = validateAttention(input['attention'])
      const tabId = `browser:agent:${crypto.randomUUID()}`
      const tab = this.host.ensureTab(tabId, projectId, threadId)
      tab.initialNavigationStarted = true
      // Mount the tab offscreen before anything else: the page must run whether
      // or not the user ends up looking at it.
      this.host.parkTab(tabId)
      this.host.load(tabId, url)
      this.host.agentTabIds.set(contextKey, tabId)
      // An opportunistic reveal is skipped once the user has shown twice that
      // they leave agent-opened tabs straight away.
      const relaxed = attention === 'focus' && this.host.isRelaxed(threadId)
      const reveal = attention === 'focus' && !relaxed
      if (reveal) this.host.rememberReveal(tabId, threadId)
      sendToRenderer(this.host.window.webContents, 'browser:openRequested', url, {
        projectId,
        threadId,
        requestedTabId: tabId,
        reveal,
        boxId: tab.boxId
      })
      return {
        ...this.host.utilityTabContext(tabId, tab),
        viewport: this.host.parkedViewportFor(tab),
        attention: reveal ? 'focus' : 'background',
        relaxed,
        page: this.host.stateFor(tabId, tab),
        ...this.host.threadBrowserHint(scope, tabId)
      }
    }

    const page = validateUtilityPage(input['page'])
    const target = this.host.utilityTarget({ scope, threadId, contextKey, page })
    if (!target) {
      // The conversation's browser holding a page this process has not mounted, or
      // a browser conversation's bound page that is not in memory right now, is
      // told exactly that instead of being told to open a page it already has.
      throw new Error(
        page === 'user'
          ? 'The thread browser has no page for this conversation right now, so there is nothing to read. Open a page of your own with "open" if you need one.'
          : page === 'agent'
            ? 'You have no page of your own open in this conversation. Open one with "open", or pass page "user" to reach the thread browser\u2019s page.'
            : this.host.assistantPageTabIds.has(threadId)
              ? 'The page the user is on is not loaded right now, so it cannot be read. Open a page of your own with "open" if you need one.'
              : 'Open a browser page before using this operation'
      )
    }
    const { tabId, tab, attached } = target
    if (!attached && (tab.projectId !== projectId || tab.threadId !== threadId)) {
      throw new Error('The current browser tab belongs to a different project or thread')
    }
    // Review effects, rather than prompting for every click on an attached page.
    // Agent-owned pages use the same gate; uploads keep their exact-file review.
    let reviewedTarget: BrowserActionTarget | null = null
    if (attached && !ATTACHED_PAGE_READ_OPERATIONS.has(operation)) {
      if (!ATTACHED_PAGE_MUTATION_OPERATIONS.has(operation)) {
        throw new Error(
          `The page the user is on is attached for reading (${[...ATTACHED_PAGE_READ_OPERATIONS].join(', ')}), so "${operation}" is unavailable.`
        )
      }
    }
    if (
      context.permissionLevel !== 'full_access' &&
      ATTACHED_PAGE_MUTATION_OPERATIONS.has(operation) &&
      operation !== 'upload'
    ) {
      const reviewed = await this.approveAttachedPageOperation(operation, input, tab, {
        projectId,
        threadId,
        sessionId: context.sessionId
      })
      if (!reviewed.approved) {
        return {
          ...this.host.utilityTabContext(tabId, tab),
          page: attached ? 'user' : 'agent',
          cancelled: true,
          ...this.host.threadBrowserHint(scope, tabId)
        }
      }
      reviewedTarget = reviewed.target
    }
    // An operation is a use: it revives a tab the agent owns that was evicted
    // from the parked set, and protects it from eviction while the agent keeps
    // working on it. A page belonging to the user is never parked, claimed or
    // touched by that bookkeeping.
    if (!attached) {
      if (this.host.activeTabId !== tabId && !this.host.stage.isParked(tab.view)) {
        this.host.parkTab(tabId)
      } else {
        this.host.touchParkedTab(tabId)
      }
    }
    const utilityContext = {
      ...this.host.utilityTabContext(tabId, tab),
      // Which page the answer came from, so the agent can tell a page it opened
      // apart from the page the user is reading.
      page: attached ? ('user' as const) : ('agent' as const),
      ...this.host.threadBrowserHint(scope, tabId)
    }
    if (operation === 'viewport') {
      const viewport = validateViewportRequest(
        input,
        tab.requestedViewport?.viewport ?? DEFAULT_PARKED_VIEWPORT
      )
      tab.requestedViewport = { viewport, at: Date.now() }
      if (this.host.stage.isParked(tab.view)) {
        // Re-park rather than setBounds directly: the stage owns where each
        // parked view sits inside its window.
        this.host.stage.park(tab.view, viewport)
        return { ...utilityContext, viewport, applied: 'parked' }
      }
      return {
        ...utilityContext,
        viewport,
        applied: 'displayed',
        detail:
          'The user is viewing this tab, so it is laid out at the on-screen size right now. This viewport applies the next time the tab is parked, unless the user displays it at a size of their own after this request.'
      }
    }
    if (operation === 'navigate') {
      const url = validateBrowserUrl(this.host.requiredInputString(input, 'url'))
      this.host.load(tabId, url)
      return { ...utilityContext, url }
    }
    if (operation === 'reload') {
      liveContents(tab.view)?.reload()
      return { ...utilityContext, reloading: true }
    }
    if (operation === 'snapshot') {
      const snapshot = await this.host.runAgentScript(
        tab.view.webContents,
        agentSnapshotScript({
          interactiveOnly: input['interactiveOnly'] !== false,
          maxElements: this.host.agentBoundedNumber(input['maxElements'], 300, 1, 1000),
          maxText:
            input['text'] === false
              ? 0
              : this.host.agentBoundedNumber(input['maxText'], 20000, 0, 40000)
        })
      )
      return {
        ...utilityContext,
        snapshot,
        detail:
          'Each element carries ref (pass it as ref to act on that element), its unique CSS selector, its live value, checked state and box, so an action targets exactly what was read.'
      }
    }
    if (operation === 'click') {
      const selector = this.host.agentSelector(input)
      const contents = tab.view.webContents
      if (await this.host.agentTargetChanged(contents, selector, reviewedTarget)) {
        return {
          ...utilityContext,
          result: { clicked: false, reason: 'target changed; inspect the page and retry' }
        }
      }
      return { ...utilityContext, result: await this.host.clickAgentTarget(tab, selector, input) }
    }
    if (operation === 'type') {
      const selector = this.host.agentSelector(input)
      const text = this.host.requiredInputString(input, 'text', true)
      const contents = tab.view.webContents
      if (await this.host.agentTargetChanged(contents, selector, reviewedTarget)) {
        return {
          ...utilityContext,
          result: { typed: false, reason: 'target changed; inspect the page and retry' }
        }
      }
      const result = await this.host.runAgentScript(
        contents,
        agentTypeScript({ selector, text, append: input['append'] === true })
      )
      await this.host.paintAgentCursorAtElement(tab, selector, false)
      if (input['submit'] === true) {
        await pressAgentKey(contents, { key: 'Enter', modifiers: [], times: 1 })
      }
      return { ...utilityContext, result }
    }
    if (operation === 'press') {
      const contents = tab.view.webContents
      const selector = this.host.optionalAgentSelector(input)
      if (selector) {
        const focused = await this.host.runAgentScript(contents, agentFocusScript(selector))
        if (asObject(focused)?.['focused'] !== true) {
          return {
            ...utilityContext,
            result: { pressed: false, reason: 'the target could not be focused', detail: focused }
          }
        }
        await this.host.paintAgentCursorAtElement(tab, selector, false)
      }
      const result = await pressAgentKey(contents, {
        key: this.host.requiredInputString(input, 'key'),
        modifiers: normalizeAgentModifiers(input['modifiers']),
        times: agentCount(input['times'], 1, 20)
      })
      return { ...utilityContext, result: { ...result, focused: selector ?? 'current focus' } }
    }
    if (operation === 'select') {
      const selector = this.host.agentSelector(input)
      const contents = tab.view.webContents
      if (await this.host.agentTargetChanged(contents, selector, reviewedTarget)) {
        return {
          ...utilityContext,
          result: { selected: false, reason: 'target changed; inspect the page and retry' }
        }
      }
      const values = Array.isArray(input['values'])
        ? (input['values'] as unknown[]).filter(
            (value): value is string => typeof value === 'string'
          )
        : []
      const result = await this.host.runAgentScript(
        contents,
        agentSelectScript({
          selector,
          ...(typeof input['value'] === 'string' ? { value: input['value'] } : {}),
          ...(typeof input['label'] === 'string' ? { label: input['label'] } : {}),
          ...(values.length > 0 ? { values } : {})
        })
      )
      return { ...utilityContext, result }
    }
    if (operation === 'check') {
      const selector = this.host.agentSelector(input)
      const contents = tab.view.webContents
      if (await this.host.agentTargetChanged(contents, selector, reviewedTarget)) {
        return {
          ...utilityContext,
          result: { checked: false, reason: 'target changed; inspect the page and retry' }
        }
      }
      const result = await this.host.runAgentScript(
        contents,
        agentCheckScript({ selector, checked: input['checked'] !== false })
      )
      return { ...utilityContext, result }
    }
    if (operation === 'scroll') {
      const contents = tab.view.webContents
      const selector = this.host.optionalAgentSelector(input)
      const to = input['to'] === 'top' || input['to'] === 'bottom' ? input['to'] : undefined
      const result = await this.host.runAgentScript(
        contents,
        agentScrollScript({
          ...(selector ? { selector } : {}),
          deltaX: this.host.agentSignedNumber(input['deltaX'], 0),
          deltaY: this.host.agentSignedNumber(input['deltaY'], selector || to ? 0 : 600),
          ...(to ? { to } : {})
        })
      )
      return { ...utilityContext, result }
    }
    if (operation === 'mouse') {
      const contents = tab.view.webContents
      const action = input['action']
      if (
        action !== 'move' &&
        action !== 'hover' &&
        action !== 'click' &&
        action !== 'down' &&
        action !== 'up' &&
        action !== 'wheel'
      ) {
        throw new TypeError('action must be move, hover, click, down, up, or wheel')
      }
      const point = await this.host.agentPointFrom(input, tab, 'point')
      const button =
        input['button'] === 'right' || input['button'] === 'middle' ? input['button'] : 'left'
      await sendAgentMouse(contents, {
        action,
        x: point.x,
        y: point.y,
        button,
        clickCount: agentCount(input['clickCount'], 1, 3),
        deltaX: this.host.agentSignedNumber(input['deltaX'], 0),
        deltaY: this.host.agentSignedNumber(input['deltaY'], 0),
        modifiers: normalizeAgentModifiers(input['modifiers'])
      })
      const pressed = action === 'click' || action === 'down'
      await this.host.paintAgentCursor(tab, point, pressed)
      return {
        ...utilityContext,
        result: { action, x: point.x, y: point.y, button, trusted: true }
      }
    }
    if (operation === 'drag') {
      const contents = tab.view.webContents
      const from = await this.host.agentPointFrom(input, tab, 'from')
      const to = await this.host.agentPointFrom(input, tab, 'to')
      const modifiers = normalizeAgentModifiers(input['modifiers'])
      const result = await dragAgentMouse(contents, { from, to, modifiers })
      await this.host.paintAgentCursor(tab, to, true)
      return { ...utilityContext, result: { ...result, from, to, trusted: true } }
    }
    if (operation === 'wait') {
      const result = await this.host.runAgentScript(
        tab.view.webContents,
        agentWaitScript({
          ...(typeof input['selector'] === 'string' ? { selector: input['selector'] } : {}),
          ...(typeof input['text'] === 'string' ? { text: input['text'] } : {}),
          ...(typeof input['urlIncludes'] === 'string'
            ? { urlIncludes: input['urlIncludes'] }
            : {}),
          ...(input['gone'] === true ? { gone: true } : {}),
          ...(input['visible'] === false ? { visible: false } : {}),
          timeoutMs: this.host.agentBoundedNumber(input['timeoutMs'], 5000, 0, 30000)
        })
      )
      return { ...utilityContext, result }
    }
    if (operation === 'evaluate') {
      const expression = this.host.requiredInputString(input, 'expression')
      const result = await this.host.runAgentScript(
        tab.view.webContents,
        agentEvaluateScript(expression)
      )
      return { ...utilityContext, result }
    }
    if (operation === 'upload') {
      const result = await this.host.uploadFiles(tabId, tab, input, context.permissionLevel)
      return { ...utilityContext, result }
    }
    if (operation === 'screenshot') {
      return { ...utilityContext, ...(await this.host.captureScreenshot(tabId, tab, input)) }
    }
    if (operation === 'console') {
      return { ...utilityContext, entries: [...tab.consoleEntries] }
    }
    throw new Error(`In-app browser does not expose the operation "${operation}"`)
  }

  /** Route a browser action through the ledger and confirm consequential effects. */
  async approveAttachedPageOperation(
    operation: string,
    input: Record<string, unknown>,
    tab: BrowserTab,
    context: { projectId: string; threadId: string; sessionId?: string }
  ): Promise<{ approved: boolean; target: BrowserActionTarget | null }> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) throw new Error('The browser page is no longer available')
    const pageUrl = contents.getURL()
    const pageGeneration = tab.navigationGeneration
    const target = await this.reviewedActionTarget(operation, input, tab)
    const review = reviewBrowserAction(operation, input, target)
    const action = this.describeAgentAction(operation, input)

    const approver = this.host.agentActionApprover
    if (!approver) throw new Error('Browser conversation approval is unavailable')
    const decision = await approver({
      ...context,
      operation,
      action,
      origin: safeOrigin(pageUrl),
      pageUrl,
      review
    })
    const approved = typeof decision === 'boolean' ? decision : decision.approved
    if (typeof decision !== 'boolean' && decision.alternative) {
      throw new Error(`Browser action rejected. User instruction: ${decision.alternative}`)
    }
    if (!approved) return { approved: false, target }
    if (
      contents.isDestroyed() ||
      tab.navigationGeneration !== pageGeneration ||
      contents.getURL() !== pageUrl
    ) {
      throw new Error(
        'The page changed while the browser action was being approved; retry on the current page'
      )
    }
    return { approved: true, target }
  }

  /**
   * The control a review is about: the one an element operation names, or the one
   * under the pointer a coordinate operation aims at.
   *
   * A pointer operation carries no element, so the review has to ask the page what
   * is at that point. Without it, clicking a Delete button by coordinate would be
   * reviewed as an unidentified action and treated as high risk every time.
   */
  async reviewedActionTarget(
    operation: string,
    input: Record<string, unknown>,
    tab: BrowserTab
  ): Promise<BrowserActionTarget | null> {
    const contents = tab.view.webContents
    const selector = this.host.optionalAgentSelector(input)
    if (selector) {
      return asBrowserActionTarget(
        await contents.executeJavaScript(browserActionTargetScript(selector))
      )
    }
    if (operation === 'mouse' || operation === 'drag') {
      const point = await this.host
        .agentPointFrom(input, tab, operation === 'drag' ? 'to' : 'point')
        .catch(() => null)
      if (!point) return null
      const hit = asObject(await contents.executeJavaScript(agentHitTestScript(point)))
      const hitSelector = typeof hit?.['selector'] === 'string' ? hit['selector'] : ''
      if (!hitSelector) return null
      return asBrowserActionTarget(
        await contents.executeJavaScript(browserActionTargetScript(hitSelector))
      )
    }
    return null
  }

  /** The sentence the permission card shows for one agent action. */
  describeAgentAction(operation: string, input: Record<string, unknown>): string {
    const target = (): string => this.host.agentSelector(input)
    switch (operation) {
      case 'click':
        return `Click the element matching this selector:\n${target()}`
      case 'type':
        return `Replace the value of this element:\n${target()}\n\nWith this text:\n${this.host.requiredInputString(input, 'text', true)}`
      case 'press': {
        const selector = this.host.optionalAgentSelector(input)
        const modifiers = normalizeAgentModifiers(input['modifiers'])
        const chord = [...modifiers, this.host.requiredInputString(input, 'key')].join('+')
        return selector
          ? `Press ${chord} in this element:\n${selector}`
          : `Press ${chord} on the focused element.`
      }
      case 'select':
        return `Choose an option in this select:\n${target()}\n\nOption:\n${JSON.stringify({ value: input['value'], label: input['label'], values: input['values'] })}`
      case 'check':
        return `${input['checked'] === false ? 'Untick' : 'Tick'} this control:\n${target()}`
      case 'scroll':
        return 'Scroll the page.'
      case 'mouse':
        return `Move or press the pointer in the page:\n${JSON.stringify({ action: input['action'], x: input['x'], y: input['y'], selector: input['selector'], ref: input['ref'], button: input['button'] })}`
      case 'drag':
        return `Drag in the page:\n${JSON.stringify({ from: input['from'], to: input['to'] })}`
      case 'evaluate':
        return `Run this expression in the page:\n${this.host.requiredInputString(input, 'expression').slice(0, 2000)}`
      case 'navigate':
        return `Navigate the current tab to:\n${validateBrowserUrl(this.host.requiredInputString(input, 'url'))}`
      case 'reload':
        return 'Reload the current page.'
      case 'viewport':
        return `Change the page viewport to:\n${JSON.stringify(input)}`
      default:
        return `Open this file for the page to read:\n${JSON.stringify(input['paths'] ?? 'the file chooser')}`
    }
  }
}
