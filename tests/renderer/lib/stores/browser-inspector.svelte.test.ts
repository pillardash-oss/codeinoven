// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { designElementReference, designPageIdentity } from '$lib/design-element-reference'

const invoke = vi.hoisted(() => vi.fn())
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
const subscribe = vi.hoisted(() => (name: string, callback: (...args: unknown[]) => void) => {
  handlers.set(name, callback)
  return () => handlers.delete(name)
})

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))
vi.mock('$lib/system/renderer-logger', () => ({ logRendererError: vi.fn() }))
vi.mock('$lib/stores/renderer-recovery.svelte', () => ({
  rendererRecovery: { setPromptReferences: vi.fn() }
}))

const PROJECT = 'project-one'
const THREAD = 'thread-one'
const TAB = 'browser:screen:one'

const tab = {
  id: TAB,
  kind: 'browser' as const,
  projectId: PROJECT,
  threadId: THREAD,
  url: 'http://127.0.0.1:52035/index.html'
}

/** The sidebar a session reads, written through the way the app writes it. */
interface SidebarHandle {
  contextSidebarState: {
    sidebarActiveTabId: string | null
    browserTabs: (typeof tab)[]
    focus: (tabId: string) => void
  }
}

/**
 * Stand in for the sidebar, reactive like the real store is.
 *
 * `sidebarActiveTabId` is the one thing the session's tab pass follows, so a
 * plain value would leave that pass with nothing to depend on: showing a tab
 * would never ask the page on screen again and a test built on it would prove
 * nothing about the behaviour it claims to pin. Each session gets its own state,
 * because a session's effect outlives the test that started it and would
 * otherwise answer the next test's questions.
 */
async function mockSidebar(): Promise<void> {
  vi.doMock('$lib/stores/context-sidebar.svelte', async () => {
    const { SvelteMap } = await import('svelte/reactivity')
    const activeTabId = new SvelteMap<string, string>()
    return {
      contextSidebarState: {
        get sidebarActiveTabId(): string | null {
          return activeTabId.get('active') ?? null
        },
        set sidebarActiveTabId(value: string | null) {
          if (value === null) activeTabId.delete('active')
          else activeTabId.set('active', value)
        },
        browserTabs: [],
        focus: vi.fn()
      }
    }
  })
}

/** A fresh session per case, so one test's tabs never leak into the next. */
async function freshSession() {
  vi.resetModules()
  handlers.clear()
  await mockSidebar()
  // One at a time: the sidebar's mock answers with a promise, and asking for it
  // while the rest of the graph is still loading hands one of the importers the
  // real store instead.
  const module = await import('$lib/stores/browser-inspector.svelte')
  const references = await import('$lib/stores/response-references.svelte')
  const sidebar = await import('$lib/stores/context-sidebar.svelte')
  const session = {
    browserInspector: module.browserInspector,
    responseReferencesState: references.responseReferencesState,
    sidebar: sidebar as unknown as SidebarHandle
  }
  // A session starts the way a restored thread does: its screen is open and
  // nothing is shown yet.
  session.sidebar.contextSidebarState.browserTabs = [{ ...tab }]
  session.sidebar.contextSidebarState.sidebarActiveTabId = null
  return session
}

/** A promise the test settles itself, so an answer can be held in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function pageReads(): number {
  return invoke.mock.calls.filter(([channel]) => channel === 'browser:pageState').length
}

const DESIGN_DIRECTORY = '.cio/designs/authorize-device'

function designReference(
  id: string,
  options: {
    tabId?: string
    directory?: string
    designEntry?: string
    label?: string
  } = {}
) {
  const directory = options.directory ?? DESIGN_DIRECTORY
  const designEntry = options.designEntry ?? 'index.html'
  return {
    id,
    kind: 'design' as const,
    label: options.label ?? 'Design element',
    text: 'Design element: div#otp\nselector: div#otp',
    selector: 'div#otp',
    tabId: options.tabId ?? TAB,
    directory,
    designEntry,
    designId: designPageIdentity(directory, designEntry)
  }
}

/** The design report main publishes when a tab commits to a design page. */
function reportDesign(
  tabId: string,
  options: { directory?: string; entry?: string; origin?: string } = {}
) {
  const directory = options.directory ?? DESIGN_DIRECTORY
  const origin = options.origin ?? 'http://127.0.0.1:52035'
  const entry = options.entry ?? 'index.html'
  handlers.get('browser:state')?.({
    tabId,
    design: { directory, origin },
    url: `${origin}/${entry}`
  })
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
})

describe('design pins', () => {
  it('names the design page a picked element belongs to, not only its tab', () => {
    const reference = designElementReference(
      'marker-one',
      {
        selector: 'div#otp',
        tag: 'div',
        id: 'otp',
        classes: [],
        role: null,
        text: 'Code',
        html: '<div id="otp"></div>',
        ancestors: [],
        frame: null,
        rect: { x: 10, y: 20, width: 30, height: 40 },
        viewport: { width: 1512, height: 850 }
      },
      { directory: DESIGN_DIRECTORY, origin: 'http://127.0.0.1:52035' },
      { id: TAB, url: 'http://127.0.0.1:52035/index.html' }
    )

    expect(reference.designId).toBe(designPageIdentity(DESIGN_DIRECTORY, 'index.html'))
  })

  it('publishes restored comments before the tab design is mirrored', async () => {
    const { browserInspector, responseReferencesState } = await freshSession()
    browserInspector.start()
    invoke.mockClear()

    responseReferencesState.setForThread(PROJECT, THREAD, [designReference('marker-one')])

    expect(invoke).toHaveBeenCalledWith('browser:inspectMarkers', TAB, [
      {
        id: 'marker-one',
        number: 1,
        comment: '',
        selector: 'div#otp'
      }
    ])
  })

  it('draws a comment written in another tab on the same design page', async () => {
    const session = await freshSession()
    const { browserInspector, responseReferencesState, sidebar } = session
    const threadTab = 'browser:agent:same-design'
    sidebar.contextSidebarState.browserTabs = [
      {
        ...tab,
        id: threadTab,
        url: 'http://127.0.0.1:52035/index.html'
      },
      { ...tab }
    ]
    // The comment was written on the thread's own tab, which the agent opened.
    responseReferencesState.setForThread(PROJECT, THREAD, [
      designReference('marker-one', { tabId: threadTab })
    ])
    browserInspector.start()
    invoke.mockClear()

    // The board opens the same screen in its own tab, which has another id.
    reportDesign(TAB)

    expect(browserInspector.markersFor(TAB)).toEqual([
      { id: 'marker-one', number: 1, comment: '', selector: 'div#otp' }
    ])
    expect(invoke).toHaveBeenCalledWith('browser:inspectMarkers', TAB, [
      { id: 'marker-one', number: 1, comment: '', selector: 'div#otp' }
    ])
  })

  it('keeps a design comment off another project that spells the folder the same', async () => {
    const session = await freshSession()
    const { browserInspector, responseReferencesState } = session
    responseReferencesState.setForThread('project-two', THREAD, [
      designReference('marker-two', { tabId: 'browser:agent:project-two' })
    ])
    browserInspector.start()
    invoke.mockClear()

    reportDesign(TAB)

    expect(browserInspector.markersFor(TAB)).toEqual([])
  })

  it('opens the tab already showing the comment design when the recorded tab is gone', async () => {
    const session = await freshSession()
    const { browserInspector, responseReferencesState } = session
    responseReferencesState.setForThread(PROJECT, THREAD, [
      designReference('marker-one', { tabId: 'browser:agent:closed' })
    ])
    browserInspector.start()
    reportDesign(TAB)
    invoke.mockClear()

    browserInspector.revealComment(
      PROJECT,
      THREAD,
      designReference('marker-one', { tabId: 'browser:agent:closed' })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(invoke).toHaveBeenCalledWith('browser:inspectSetArmed', TAB, true, undefined)
    expect(invoke).toHaveBeenCalledWith('browser:inspectMarkers', TAB, [
      { id: 'marker-one', number: 1, comment: '', selector: 'div#otp' }
    ])
    expect(invoke).not.toHaveBeenCalledWith(
      'design:open',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('opens the design again when the listed tab is already gone in main', async () => {
    const session = await freshSession()
    const { browserInspector, responseReferencesState } = session
    const reopened = 'browser:screen:reopened'
    responseReferencesState.setForThread(PROJECT, THREAD, [designReference('marker-one')])
    browserInspector.start()
    reportDesign(TAB)
    invoke.mockClear()
    invoke.mockImplementation((channel: string, tabId: string) => {
      if (channel === 'browser:inspectSetArmed' && tabId === TAB) {
        return Promise.reject(new Error('Browser tab does not exist'))
      }
      if (channel === 'design:open') return Promise.resolve({ tabId: reopened })
      return Promise.resolve(undefined)
    })

    browserInspector.revealComment(PROJECT, THREAD, designReference('marker-one'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(invoke).toHaveBeenCalledWith(
      'design:open',
      PROJECT,
      THREAD,
      DESIGN_DIRECTORY,
      'index.html',
      true,
      'design'
    )
    expect(invoke).toHaveBeenCalledWith('browser:inspectSetArmed', reopened, true, undefined)
  })

  it('reads the page on screen again even though its state was read once', async () => {
    const { browserInspector, sidebar } = await freshSession()
    const firstAnswer = deferred<{ tabId: string; design: null }>()
    let answers = 0
    invoke.mockImplementation((channel: string) => {
      if (channel !== 'browser:pageState') return Promise.resolve(undefined)
      answers += 1
      return answers === 1 ? firstAnswer.promise : Promise.resolve({ tabId: TAB, design: null })
    })
    browserInspector.start()
    flushSync()
    expect(pageReads()).toBe(1)

    // The reader shows the tab while the first answer is still on its way, which
    // is the window a restored tab opens in: the question was asked before the
    // page was on screen, so it cannot be the one that answers for it.
    sidebar.contextSidebarState.sidebarActiveTabId = TAB
    flushSync()
    await Promise.resolve()
    expect(pageReads()).toBe(1)

    firstAnswer.resolve({ tabId: TAB, design: null })
    await vi.waitFor(() => expect(pageReads()).toBe(2))
  })
})

describe('the open comment', () => {
  it('resolves its reference from the conversation that owns the tab', async () => {
    const { browserInspector, responseReferencesState } = await freshSession()
    invoke.mockImplementation((channel: string) =>
      channel === 'browser:pageState'
        ? Promise.resolve({
            tabId: TAB,
            design: { directory: '.cio/designs/authorize-device', origin: 'http://127.0.0.1:52035' }
          })
        : Promise.resolve(undefined)
    )
    responseReferencesState.setForThread(PROJECT, THREAD, [designReference('marker-one')])
    browserInspector.start()

    const pick = handlers.get('browser:inspector')
    expect(pick).toBeDefined()
    pick?.(TAB, {
      kind: 'pick',
      id: 'marker-one',
      anchor: { x: 10, y: 20, width: 30, height: 40 },
      target: {
        selector: 'div#otp',
        tag: 'div',
        id: 'otp',
        classes: [],
        role: null,
        text: 'Code',
        html: '<div id="otp"></div>',
        ancestors: [],
        frame: null,
        rect: { x: 10, y: 20, width: 30, height: 40 },
        viewport: { width: 1512, height: 850 }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const open = browserInspector.commentFor(TAB)
    expect(open?.referenceId).toBe('marker-one')
    expect(open?.projectId).toBe(PROJECT)
    expect(open?.threadId).toBe(THREAD)
    expect(open?.reference.comment).toBeUndefined()
  })

  it('has no comment once its tab is gone', async () => {
    const { browserInspector, sidebar } = await freshSession()
    browserInspector.start()
    sidebar.contextSidebarState.browserTabs = []
    expect(browserInspector.commentFor(TAB)).toBeNull()
  })
})

describe('a tab that moved to another conversation', () => {
  /** The same screen opened from a second conversation moves its one tab there. */
  const OTHER_PROJECT = 'project-two'
  const OTHER_THREAD = 'thread-two'

  function movedTab(session: Awaited<ReturnType<typeof freshSession>>): void {
    session.sidebar.contextSidebarState.browserTabs = [
      { ...tab, projectId: OTHER_PROJECT, threadId: OTHER_THREAD }
    ]
  }

  it('still draws the pins of the conversation that wrote the comment', async () => {
    const session = await freshSession()
    const { browserInspector, responseReferencesState } = session
    browserInspector.start()
    invoke.mockClear()
    responseReferencesState.setForThread(PROJECT, THREAD, [designReference('marker-one')])
    movedTab(session)
    invoke.mockClear()

    expect(browserInspector.markersFor(TAB)).toEqual([
      { id: 'marker-one', number: 1, comment: '', selector: 'div#otp' }
    ])
    browserInspector.focusComment(TAB, 'marker-one')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invoke).toHaveBeenCalledWith('browser:inspectMarkers', TAB, [
      { id: 'marker-one', number: 1, comment: '', selector: 'div#otp' }
    ])
  })

  it('keeps its open comment resolvable, in the conversation that wrote it', async () => {
    const session = await freshSession()
    const { browserInspector, responseReferencesState } = session
    responseReferencesState.setForThread(PROJECT, THREAD, [designReference('marker-one')])
    browserInspector.start()
    invoke.mockImplementation((channel: string) =>
      channel === 'browser:pageState'
        ? Promise.resolve({
            tabId: TAB,
            design: { directory: '.cio/designs/authorize-device', origin: 'http://127.0.0.1:52035' }
          })
        : Promise.resolve(undefined)
    )

    const pick = handlers.get('browser:inspector')
    pick?.(TAB, {
      kind: 'open',
      id: 'marker-one',
      anchor: { x: 10, y: 20, width: 30, height: 40 }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The screen is opened again from a second conversation, which takes the
    // one tab for it with it.
    movedTab(session)

    const open = browserInspector.commentFor(TAB)
    expect(open?.referenceId).toBe('marker-one')
    expect(open?.projectId).toBe(PROJECT)
    expect(open?.threadId).toBe(THREAD)
  })

  it('closes the comment when it is removed from the conversation that wrote it', async () => {
    const session = await freshSession()
    const { browserInspector, responseReferencesState } = session
    responseReferencesState.setForThread(PROJECT, THREAD, [designReference('marker-one')])
    browserInspector.start()
    movedTab(session)
    const pick = handlers.get('browser:inspector')
    pick?.(TAB, {
      kind: 'open',
      id: 'marker-one',
      anchor: { x: 10, y: 20, width: 30, height: 40 }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(browserInspector.commentFor(TAB)).not.toBeNull()

    responseReferencesState.setForThread(PROJECT, THREAD, [])
    flushSync()
    expect(browserInspector.commentFor(TAB)).toBeNull()
  })
})
