// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'

const invoke = vi.hoisted(() => vi.fn())
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
const subscribe = vi.hoisted(() => (name: string, callback: (...args: unknown[]) => void) => {
  handlers.set(name, callback)
  return () => handlers.delete(name)
})
const sidebar = vi.hoisted(() => ({
  contextSidebarState: {
    sidebarActiveTabId: null as string | null,
    browserTabs: [] as {
      id: string
      kind: 'browser'
      projectId: string
      threadId: string
      url: string
    }[]
  }
}))

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))
vi.mock('$lib/stores/context-sidebar.svelte', () => sidebar)
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

/** A fresh session per case, so one test's tabs never leak into the next. */
async function freshSession() {
  vi.resetModules()
  handlers.clear()
  const [module, references] = await Promise.all([
    import('$lib/stores/browser-inspector.svelte'),
    import('$lib/stores/response-references.svelte')
  ])
  return {
    browserInspector: module.browserInspector,
    responseReferencesState: references.responseReferencesState
  }
}

function designReference(id: string) {
  return {
    id,
    kind: 'design' as const,
    label: 'Design element',
    text: 'Design element: div#otp\nselector: div#otp',
    selector: 'div#otp',
    tabId: TAB,
    directory: '.cio/designs/authorize-device',
    designEntry: 'index.html'
  }
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  sidebar.contextSidebarState.sidebarActiveTabId = null
  sidebar.contextSidebarState.browserTabs = [{ ...tab }]
})

describe('design pins', () => {
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

  it('reads the page on screen again even though its state was read once', async () => {
    const { browserInspector } = await freshSession()
    invoke.mockImplementation((channel: string) =>
      channel === 'browser:pageState'
        ? Promise.resolve({ tabId: TAB, design: null })
        : Promise.resolve(undefined)
    )
    browserInspector.start()
    flushSync()
    const readsAfterStart = invoke.mock.calls.filter(
      ([channel]) => channel === 'browser:pageState'
    ).length
    expect(readsAfterStart).toBe(1)

    sidebar.contextSidebarState.sidebarActiveTabId = TAB
    flushSync()
    await Promise.resolve()

    const readsAfterShow = invoke.mock.calls.filter(
      ([channel]) => channel === 'browser:pageState'
    ).length
    expect(readsAfterShow).toBe(2)
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
    const { browserInspector } = await freshSession()
    browserInspector.start()
    sidebar.contextSidebarState.browserTabs = []
    expect(browserInspector.commentFor(TAB)).toBeNull()
  })
})
