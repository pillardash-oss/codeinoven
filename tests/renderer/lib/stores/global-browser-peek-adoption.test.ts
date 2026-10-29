import { describe, expect, it, vi } from 'vitest'
import { SvelteMap } from 'svelte/reactivity'

// The gauge is a page's own business here: only the branch is under test.
vi.mock('$lib/ipc.svelte', () => ({ invoke: () => Promise.resolve(null) }))
vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: { sourceTabId: 'browser:on-screen' }
}))
vi.mock('$lib/stores/context-sidebar.svelte', () => ({
  contextSidebarState: { threadIdForProject: () => null }
}))
vi.mock('$lib/stores/browser-audio.svelte', () => ({
  browserAudio: { forget: () => {} }
}))
vi.mock('$lib/stores/global-browser.svelte', () => ({
  withDefaultBox: (boxes: unknown[]) => boxes,
  GLOBAL_BROWSER_CONTEXT: { projectId: 'browser-global', threadId: 'browser-global' }
}))

import { GlobalBrowserStateInstallation } from '$lib/stores/global-browser/global-browser-installation'
import type { GlobalBrowserState } from '$lib/stores/global-browser.svelte'

/**
 * The peek branch of `browser:openRequested`.
 *
 * Both ways of asking for a peek - the context menu's Take a Peek and an
 * Option-click on a link - arrive here after main has parked and loaded the page,
 * and everything downstream reads the record this branch registers. So this test
 * is the gesture's own guard: if the record is not registered, Take a Peek is a
 * click that does nothing at all, with no error anywhere.
 */

interface FakeHost {
  tabs: unknown[]
  peeks: SvelteMap<string, unknown>
  runtime: Map<string, unknown>
  tabById: () => null
  applyPageState: () => void
  activate: () => void
  units: Record<string, Record<string, () => void>>
}

function fakeHost(): GlobalBrowserState {
  const host: FakeHost = {
    tabs: [],
    peeks: new SvelteMap(),
    runtime: new Map(),
    tabById: () => null,
    applyPageState: () => {},
    activate: () => {},
    units: {
      queries: { persist: () => {}, forgetPeek: () => {} },
      runtime: { enforceTabCap: () => {}, insertTabBeside: () => {} }
    }
  }
  return host as unknown as GlobalBrowserState
}

function peekRequest(
  overrides: Record<string, unknown> = {}
): Parameters<GlobalBrowserStateInstallation['adoptOpenRequest']>[1] {
  return {
    projectId: 'browser-global',
    threadId: 'browser-global',
    requestedTabId: 'browser:peek',
    sourceTabId: 'browser:on-screen',
    peek: true,
    reveal: true,
    boxId: null,
    origin: null,
    ...overrides
  } as Parameters<GlobalBrowserStateInstallation['adoptOpenRequest']>[1]
}

describe('a peek the renderer is asked for', () => {
  it('registers the peek under the tab it was taken from', () => {
    const host = fakeHost()
    new GlobalBrowserStateInstallation(host).adoptOpenRequest(
      'https://example.com/thing',
      peekRequest()
    )
    const peek = host.peeks.get('browser:on-screen')
    expect(peek).toBeDefined()
    expect(peek?.tab.id).toBe('browser:peek')
    expect(peek?.tab.url).toBe('https://example.com/thing')
    // The surface flies from `opening` and only a landing settles it.
    expect(peek?.phase).toBe('opening')
    expect(peek?.landed).toBe(false)
  })

  it('gives the peek to the thread whose conversation asked for it', () => {
    const host = fakeHost()
    new GlobalBrowserStateInstallation(host).adoptOpenRequest(
      'https://example.com/thing',
      peekRequest({ projectId: 'a-project', sourceTabId: 'browser:on-screen' }),
      'a-thread'
    )
    expect(host.peeks.get('browser:on-screen')?.ownerThreadId).toBe('a-thread')
  })

  it('keeps a peek out of the tab strip', () => {
    const host = fakeHost()
    new GlobalBrowserStateInstallation(host).adoptOpenRequest(
      'https://example.com/thing',
      peekRequest()
    )
    expect(host.tabs).toEqual([])
  })
})
