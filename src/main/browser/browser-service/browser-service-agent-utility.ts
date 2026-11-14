import type { PermissionLevel } from '../../../lib/types'
import {
  browserActionTargetScript,
  reviewBrowserAction,
  type BrowserActionTarget
} from './browser-action-policy'
import {
  agentCheckScript,
  agentComboboxScript,
  agentEvaluateScript,
  agentFieldValueScript,
  agentFocusScript,
  agentHitTestScript,
  agentScrollScript,
  agentSelectScript,
  agentPrepareTypingScript,
  agentSnapshotScript,
  agentTypeScript,
  agentWaitScript,
  AGENT_REF_ATTRIBUTE,
  BROWSER_WAIT_MAX_TIMEOUT_MS
} from './browser-agent-page'
import {
  agentCount,
  dragAgentMouse,
  MAX_TYPED_KEYSTROKES,
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
import type { AgentTarget } from './browser-service-agent-script'
import { comboboxOptions, pickComboboxOption } from './browser-agent-combobox'
import { asObject, safeOrigin } from './browser-service-common'
import { liveContents, liveWindowContents } from './browser-view-contents'
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

/** Elements one embedded document reports, so one frame cannot fill the whole read. */
const MAX_FRAME_ELEMENTS = 120
/** Characters of an embedded document's text a snapshot reports. */
const MAX_FRAME_TEXT = 4000
/** Times a combobox is read while its list fills, and the pause between reads. */
const COMBOBOX_POLL_ATTEMPTS = 20
const COMBOBOX_POLL_INTERVAL_MS = 100

/** A pause in the main process, for a list a page fills in its own time. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  readonly agentEntry: BrowserService['agentEntry']
  readonly agentFrames: BrowserService['agentFrames']
  readonly agentPointFrom: BrowserService['agentPointFrom']
  readonly agentSelector: BrowserService['agentSelector']
  readonly agentSignedNumber: BrowserService['agentSignedNumber']
  readonly agentTabClaims: BrowserService['agentTabClaims']
  readonly agentTabIds: BrowserService['agentTabIds']
  readonly agentTarget: BrowserService['agentTarget']
  readonly agentTargetChanged: BrowserService['agentTargetChanged']
  readonly optionalAgentTarget: BrowserService['optionalAgentTarget']
  readonly runAgentScriptIn: BrowserService['runAgentScriptIn']
  readonly assistantPageTabIds: BrowserService['assistantPageTabIds']
  readonly boxOfExistingTab: BrowserService['boxOfExistingTab']
  readonly closeUnreferencedAgentTabs: BrowserService['closeUnreferencedAgentTabs']
  readonly captureScreenshot: BrowserService['captureScreenshot']
  readonly clickAgentTarget: BrowserService['clickAgentTarget']
  readonly conversationBoxFor: BrowserService['conversationBoxFor']
  readonly conversationScope: BrowserService['conversationScope']
  readonly ensureTab: BrowserService['ensureTab']
  readonly isRelaxed: BrowserService['isRelaxed']
  readonly load: BrowserService['load']
  readonly optionalAgentSelector: BrowserService['optionalAgentSelector']
  readonly paintAgentCursor: BrowserService['paintAgentCursor']
  readonly paintAgentCursorAtElement: BrowserService['paintAgentCursorAtElement']
  readonly parkTab: BrowserService['parkTab']
  readonly parkedViewportFor: BrowserService['parkedViewportFor']
  readonly rememberReveal: BrowserService['rememberReveal']
  readonly requiredInputString: BrowserService['requiredInputString']
  readonly runAgentScript: BrowserService['runAgentScript']
  readonly stage: BrowserService['stage']
  readonly stateFor: BrowserService['stateFor']
  readonly tabs: BrowserService['tabs']
  readonly previousPageTarget: BrowserService['previousPageTarget']
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
    if (operation === 'open') {
      const url = validateBrowserUrl(this.host.requiredInputString(input, 'url'))
      const attention = validateAttention(input['attention'])
      // One agent tab per conversation. A research turn opens several pages, and
      // minting a tab for each one left a renderer process behind every time:
      // 154 processes and 7.8 GB in a five hour session. The tab this
      // conversation already owns is navigated instead.
      const existing = this.host.agentTabIds.get(contextKey) ?? null
      const reused = existing !== null && this.host.tabs.has(existing)
      const tabId = reused && existing ? existing : `browser:agent:${crypto.randomUUID()}`
      const tab = this.host.ensureTab(
        tabId,
        projectId,
        threadId,
        this.host.conversationBoxFor(projectId, threadId) ?? this.host.boxOfExistingTab(tabId)
      )
      tab.initialNavigationStarted = true
      // Mount the tab offscreen before anything else: the page must run whether
      // or not the user ends up looking at it.
      if (!reused) this.host.parkTab(tabId)
      else if (this.host.activeTabId !== tabId && !this.host.stage.isParked(tab.view)) {
        // The parked cap can drop a view off the stage window without freeing it,
        // so a reused tab is mounted again before it navigates.
        this.host.parkTab(tabId)
      }
      this.host.load(tabId, url)
      this.host.agentTabIds.set(contextKey, tabId)
      this.publishAgentClaims()
      this.host.closeUnreferencedAgentTabs(contextKey)
      // An opportunistic reveal is skipped once the user has shown twice that
      // they leave agent-opened tabs straight away.
      const relaxed = attention === 'focus' && this.host.isRelaxed(threadId)
      const reveal = attention === 'focus' && !relaxed
      if (reveal) this.host.rememberReveal(tabId, threadId)
      sendToRenderer(liveWindowContents(this.host.window), 'browser:openRequested', url, {
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
        ...this.host.threadBrowserHint(projectId, threadId, tabId, contextKey)
      }
    }

    const page = validateUtilityPage(input['page'])
    const target = this.host.utilityTarget({ projectId, threadId, contextKey, page })
    if (!target) {
      // The conversation's browser holding a page this process has not mounted, or
      // a browser conversation's bound page that is not in memory right now, is
      // told exactly that instead of being told to open a page it already has.
      throw new Error(
        page === 'user' || page === 'strip'
          ? 'The thread browser has no page for this conversation right now, so there is nothing to read. Open a page of your own with "open" if you need one.'
          : page === 'agent'
            ? 'You have no page of your own open in this conversation. Open one with "open", or pass page "user" to reach the page the thread browser resolved for you.'
            : this.host.assistantPageTabIds.has(threadId)
              ? 'The page the user is on is not loaded right now, so it cannot be read. Open a page of your own with "open" if you need one.'
              : 'Open a browser page before using this operation'
      )
    }
    // The strip names the thread behind a tab from this, so it is published the
    // moment an agent takes one, not when the tab's page happens to change.
    this.publishAgentClaims()
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
          ...this.host.threadBrowserHint(projectId, threadId, tabId, contextKey)
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
      ...this.movedPageHint(contextKey, tabId),
      ...this.host.threadBrowserHint(projectId, threadId, tabId, contextKey)
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
          'The user is viewing this tab, so it is laid out at the on-screen size right now. This viewport holds until you change it, and it is the size the page renders at the next time the tab is offscreen, however the user had it on screen.'
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
      return { ...utilityContext, ...(await this.readSnapshot(tab, input)) }
    }
    if (operation === 'click') {
      const target = this.host.agentTarget(input, tab.view.webContents)
      if (await this.host.agentTargetChanged(target, reviewedTarget)) {
        return {
          ...utilityContext,
          result: { clicked: false, reason: 'target changed; inspect the page and retry' }
        }
      }
      return { ...utilityContext, result: await this.host.clickAgentTarget(tab, target, input) }
    }
    if (operation === 'type') {
      const target = this.host.agentTarget(input, tab.view.webContents)
      const text = this.host.requiredInputString(input, 'text', true)
      if (await this.host.agentTargetChanged(target, reviewedTarget)) {
        return {
          ...utilityContext,
          result: { typed: false, reason: 'target changed; inspect the page and retry' }
        }
      }
      const result = await this.typeWithKeys(tab, target, {
        text,
        append: input['append'] === true
      })
      await this.host.paintAgentCursorAtElement(tab, target)
      if (input['submit'] === true) {
        await pressAgentKey(tab.view.webContents, {
          key: 'Enter',
          modifiers: [],
          times: 1
        })
      }
      return { ...utilityContext, result }
    }
    if (operation === 'press') {
      const contents = tab.view.webContents
      const target = this.host.optionalAgentTarget(input, contents)
      if (target) {
        const focused = await this.host.runAgentScriptIn(
          target.entry,
          agentFocusScript(target.selector)
        )
        if (asObject(focused)?.['focused'] !== true) {
          return {
            ...utilityContext,
            result: { pressed: false, reason: 'the target could not be focused', detail: focused }
          }
        }
        await this.host.paintAgentCursorAtElement(tab, target)
      }
      const result = await pressAgentKey(contents, {
        key: this.host.requiredInputString(input, 'key'),
        modifiers: normalizeAgentModifiers(input['modifiers']),
        times: agentCount(input['times'], 1, 20)
      })
      return {
        ...utilityContext,
        result: { ...result, focused: target?.selector ?? 'current focus' }
      }
    }
    if (operation === 'select') {
      const target = this.host.agentTarget(input, tab.view.webContents)
      if (await this.host.agentTargetChanged(target, reviewedTarget)) {
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
      const result = asObject(
        await this.host.runAgentScriptIn(
          target.entry,
          agentSelectScript({
            selector: target.selector,
            ...(typeof input['value'] === 'string' ? { value: input['value'] } : {}),
            ...(typeof input['label'] === 'string' ? { label: input['label'] } : {}),
            ...(values.length > 0 ? { values } : {})
          })
        )
      )
      if (result?.['selected'] === true || result?.['reason'] !== 'element is not a select') {
        return { ...utilityContext, result }
      }
      // A portal's picker is an input that owns a listbox, not a `<select>`. Choosing
      // there means opening it, typing the choice so its filter runs, and clicking the
      // option, because the text alone is thrown away the moment the field blurs.
      const query =
        (typeof input['label'] === 'string' ? input['label'] : '') ||
        (typeof input['value'] === 'string' ? input['value'] : '') ||
        values[0] ||
        ''
      const combobox = await this.chooseCombobox(tab, target, query)
      return { ...utilityContext, result: combobox ?? result }
    }
    if (operation === 'check') {
      const target = this.host.agentTarget(input, tab.view.webContents)
      if (await this.host.agentTargetChanged(target, reviewedTarget)) {
        return {
          ...utilityContext,
          result: { checked: false, reason: 'target changed; inspect the page and retry' }
        }
      }
      const result = await this.host.runAgentScriptIn(
        target.entry,
        agentCheckScript({ selector: target.selector, checked: input['checked'] !== false })
      )
      return { ...utilityContext, result }
    }
    if (operation === 'scroll') {
      const contents = tab.view.webContents
      const target = this.host.optionalAgentTarget(input, contents)
      const entry = target?.entry ?? this.host.agentEntry(input, contents)
      const to = input['to'] === 'top' || input['to'] === 'bottom' ? input['to'] : undefined
      const result = await this.host.runAgentScriptIn(
        entry,
        agentScrollScript({
          ...(target ? { selector: target.selector } : {}),
          deltaX: this.host.agentSignedNumber(input['deltaX'], 0),
          deltaY: this.host.agentSignedNumber(input['deltaY'], target || to ? 0 : 600),
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
      await this.host.paintAgentCursor(tab, point)
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
      await this.host.paintAgentCursor(tab, to)
      return {
        ...utilityContext,
        result: {
          ...result,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
          trusted: true
        }
      }
    }
    if (operation === 'wait') {
      const result = await this.host.runAgentScriptIn(
        this.host.agentEntry(input, tab.view.webContents),
        agentWaitScript({
          ...(typeof input['selector'] === 'string' ? { selector: input['selector'] } : {}),
          ...(typeof input['text'] === 'string' ? { text: input['text'] } : {}),
          ...(typeof input['urlIncludes'] === 'string'
            ? { urlIncludes: input['urlIncludes'] }
            : {}),
          ...(input['gone'] === true ? { gone: true } : {}),
          ...(input['visible'] === false ? { visible: false } : {}),
          ...(input['changed'] === true ? { changed: true } : {}),
          timeoutMs: this.host.agentBoundedNumber(
            input['timeoutMs'],
            5000,
            0,
            BROWSER_WAIT_MAX_TIMEOUT_MS
          )
        })
      )
      return { ...utilityContext, result }
    }
    if (operation === 'evaluate') {
      const expression = this.host.requiredInputString(input, 'expression')
      const result = await this.host.runAgentScriptIn(
        this.host.agentEntry(input, tab.view.webContents),
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

  /** Tell the renderer which tabs agents are on, so a tab can name its thread. */
  private publishAgentClaims(): void {
    sendToRenderer(
      liveWindowContents(this.host.window),
      'browser:agentTabClaimsChanged',
      this.host.agentTabClaims()
    )
  }

  /** Route a browser action through the ledger and confirm consequential effects. */
  /**
   * Choose an option from a combobox, the way a person does.
   *
   * Opening it, typing the choice so its own filter runs, and clicking the option is
   * the only sequence such a control keeps: the text typed into it is a query, not a
   * value, and a picker that filters a long list offers nothing until the query is
   * there. The click goes through the ordinary element path, so a choice inside a
   * frame, under an overlay, or in a portal blade is the same action. `null` means the
   * element is not a combobox at all, and the caller reports what the select said.
   */
  private async chooseCombobox(
    tab: BrowserTab,
    target: AgentTarget,
    query: string
  ): Promise<Record<string, unknown> | null> {
    const read = async (open: boolean): Promise<Record<string, unknown> | null> =>
      asObject(
        await this.host.runAgentScriptIn(
          target.entry,
          agentComboboxScript({
            selector: target.selector,
            open,
            refPrefix: target.entry.index === 0 ? '' : `f${target.entry.index}`
          })
        )
      )
    const opened = await read(true)
    if (opened?.['found'] === false) return { selected: false, reason: 'not found' }
    if (opened?.['combobox'] !== true) return null
    let state = opened
    if (query) {
      const typed = await this.typeWithKeys(tab, target, { text: query, append: false })
      if (typed['typed'] === true) state = (await read(false)) ?? state
    }
    let options = comboboxOptions(state)
    for (let attempt = 0; options.length === 0 && attempt < COMBOBOX_POLL_ATTEMPTS; attempt += 1) {
      await delay(COMBOBOX_POLL_INTERVAL_MS)
      state = (await read(false)) ?? state
      options = comboboxOptions(state)
    }
    const choice = pickComboboxOption(options, query)
    if (!choice) {
      return {
        selected: false,
        reason:
          options.length === 0
            ? 'the combobox offered no options'
            : 'no option matched what was asked for',
        ...(options.length > 0
          ? { options: options.slice(0, 20).map((option) => option.label) }
          : {})
      }
    }
    await this.host.clickAgentTarget(
      tab,
      { selector: `[${AGENT_REF_ATTRIBUTE}="${choice.ref}"]`, entry: target.entry },
      {}
    )
    const after = (await read(false)) ?? state
    return {
      selected: true,
      via: 'combobox',
      label: choice.label,
      value: String(after['value'] ?? choice.value ?? choice.label),
      ...(after['expanded'] === true ? { stillOpen: true } : {})
    }
  }

  /**
   * Type the way a hand would: focus the field, then send the text as keystrokes.
   *
   * A page distinguishes a script from a keyboard, so a field written through its value
   * setter never fires the `keydown` a search-as-you-type box, a shortcut handler or a
   * rich editor listens for. The text therefore goes in as real key sequences, up to
   * {@link MAX_TYPED_KEYSTROKES} characters; anything longer, and any text with a line
   * break (Enter submits the form it is typed into), is inserted in one step instead,
   * and the result says which happened.
   */
  private async typeWithKeys(
    tab: BrowserTab,
    target: AgentTarget,
    request: { text: string; append: boolean }
  ): Promise<Record<string, unknown>> {
    const contents = tab.view.webContents
    const prepared = asObject(
      await this.host.runAgentScriptIn(
        target.entry,
        agentPrepareTypingScript({ selector: target.selector, append: request.append })
      )
    )
    if (prepared?.['ok'] !== true) {
      return { typed: false, reason: prepared?.['reason'] ?? 'element is not editable' }
    }
    const typedWithKeys = !/[\r\n]/u.test(request.text)
      ? request.text.slice(0, MAX_TYPED_KEYSTROKES)
      : ''
    const remainder = request.text.slice(typedWithKeys.length)
    for (const character of typedWithKeys) {
      await pressAgentKey(contents, { key: character, modifiers: [], times: 1 })
    }
    if (remainder.length > 0) {
      // Keys already replaced the prepared selection, so only the rest of the text has
      // to append. When no key was sent (a line break, or an empty text that clears the
      // field) the insert carries the caller's own append flag instead.
      await this.host.runAgentScriptIn(
        target.entry,
        agentTypeScript({
          selector: target.selector,
          text: remainder,
          append: request.append || typedWithKeys.length > 0
        })
      )
    }
    const read = asObject(
      await this.host.runAgentScriptIn(target.entry, agentFieldValueScript(target.selector))
    )
    const expected =
      (request.append ? Number(prepared['previousLength'] ?? 0) : 0) + request.text.length
    const length = Number(read?.['length'] ?? 0)
    return {
      typed: true,
      mode: typedWithKeys.length === request.text.length ? 'keys' : 'inserted',
      keystrokes: typedWithKeys.length,
      inserted: remainder.length,
      applied: length === expected,
      length,
      value: read?.['value'] ?? '',
      ...(target.entry.index === 0 ? {} : { frame: target.entry.index }),
      ...(length === expected
        ? {}
        : {
            reason: 'the field did not keep the text it was given; check its type or its validation'
          })
    }
  }

  /**
   * Read the page, every document it is made of, in one call.
   *
   * A page renders its real content inside frames: a portal blade, a payment form,
   * a chat widget. Reading only the top document reported a title and nothing to
   * act on, which is exactly what left an agent clicking at invented coordinates.
   * Every frame is read here with its own reference prefix, so a control inside a
   * frame comes back with a handle that works on its own.
   */
  private async readSnapshot(
    tab: BrowserTab,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const contents = tab.view.webContents
    const interactiveOnly = input['interactiveOnly'] !== false
    const maxElements = this.host.agentBoundedNumber(input['maxElements'], 300, 1, 1000)
    const maxText =
      input['text'] === false ? 0 : this.host.agentBoundedNumber(input['maxText'], 20000, 0, 40000)
    const entries = this.host.agentFrames(contents)
    const elements: unknown[] = []
    const frames: Record<string, unknown>[] = []
    let remaining = maxElements
    let combined: Record<string, unknown> | null = null
    for (const entry of entries) {
      if (remaining <= 0 && entry.index > 0) break
      const budget = entry.index === 0 ? remaining : Math.min(remaining, MAX_FRAME_ELEMENTS)
      let report: Record<string, unknown> | null
      try {
        report = asObject(
          await this.host.runAgentScriptIn(
            entry,
            agentSnapshotScript({
              interactiveOnly,
              maxElements: Math.max(budget, 1),
              maxText: entry.index === 0 ? maxText : Math.min(maxText, MAX_FRAME_TEXT),
              refPrefix: entry.refPrefix
            })
          )
        )
      } catch (error) {
        frames.push({
          frame: entry.index,
          url: entry.url,
          name: entry.name,
          error: error instanceof Error ? error.message : String(error)
        })
        continue
      }
      if (!report) continue
      const reported = Array.isArray(report['elements']) ? report['elements'] : []
      for (const element of reported) {
        if (remaining <= 0) break
        remaining -= 1
        elements.push(
          entry.index === 0 || !asObject(element)
            ? element
            : { ...asObject(element), frame: entry.index }
        )
      }
      if (entry.index === 0) {
        combined = report
        frames.push({
          frame: 0,
          url: entry.url,
          name: entry.name,
          elements: reported.length
        })
        continue
      }
      frames.push({
        frame: entry.index,
        url: String(report['url'] ?? entry.url),
        name: entry.name,
        title: report['title'] ?? '',
        elements: reported.length,
        ...(typeof report['text'] === 'string' && report['text'].length > 0
          ? { text: report['text'] }
          : {})
      })
    }
    const snapshot = {
      ...(combined ?? {}),
      count: elements.length,
      elements,
      frames
    }
    return {
      snapshot,
      detail:
        'Each element carries ref (pass it as ref to act on that element), its unique CSS selector, its live value, checked state and box, so an action targets exactly what was read. Elements inside a frame carry a ref prefixed with that frame (f2r7) and work the same way; the frames list names every document that was read, with the text of each embedded one.'
    }
  }

  /**
   * Say so when the page moved between two calls.
   *
   * A conversation's page is the tab the user handed it, so the user pointing that
   * conversation's strip at another tab legitimately moves it. The one thing that must
   * never happen is a model typing into a different site without being told, which is
   * why the tab this call did not want is named in its result instead of silently
   * replacing the last one.
   */
  private movedPageHint(
    contextKey: string,
    answeredTabId: string
  ): { pageMoved?: { fromTabId: string; fromUrl: string; detail: string } } {
    const previous = this.host.previousPageTarget(contextKey)
    if (!previous || previous.tabId === answeredTabId) return {}
    return {
      pageMoved: {
        fromTabId: previous.tabId,
        fromUrl: previous.url,
        detail:
          'The page this call worked on is not the one the previous call worked on: the user pointed this conversation at another tab. Read the page before acting again, or open a page of your own with "open" and use page "agent" to keep one of your own.'
      }
    }
  }

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
    const target = this.host.optionalAgentTarget(input, contents)
    if (target) {
      return asBrowserActionTarget(
        await this.host.runAgentScriptIn(target.entry, browserActionTargetScript(target.selector))
      )
    }
    if (operation === 'mouse' || operation === 'drag') {
      const point = await this.host
        .agentPointFrom(input, tab, operation === 'drag' ? 'to' : 'point')
        .catch(() => null)
      if (!point) return null
      // The point is asked for inside its own document (the coordinates a hit test
      // understands), and the control it lands on is read there too.
      const hit = asObject(
        await this.host.runAgentScriptIn(
          point.entry,
          agentHitTestScript({ x: point.localX, y: point.localY })
        )
      )
      const hitSelector = typeof hit?.['selector'] === 'string' ? hit['selector'] : ''
      if (!hitSelector) return null
      return asBrowserActionTarget(
        await this.host.runAgentScriptIn(point.entry, browserActionTargetScript(hitSelector))
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
