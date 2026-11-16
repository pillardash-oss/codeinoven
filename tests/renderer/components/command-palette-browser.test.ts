// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import CommandPalette from '$lib/components/actions/CommandPalette.svelte'
import SpotlightHarness from './stubs/SpotlightHarness.svelte'
import type { ActionDefinition } from '$lib/actions'
import type { NativeDockNode, NativeDockRequest } from '$shared/native-dock'

/**
 * The Cmd+K spotlight is a `Modal` that the native projection draws above the
 * browser's page view, so opening it must never detach the browser. A palette
 * that opts out of the native presentation falls back to the app window's DOM,
 * where the only way its panel can be seen is to hide the page underneath it
 * (see `browserVisibility.hideWhile`). These tests pin that regression: the
 * spotlight keeps publishing a native projection, and the browser is never
 * suppressed while it is open.
 */
const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(true),
  listeners: new Map<string, (payload: unknown) => void>(),
  hideWhile: vi.fn<(key: string, reason: string, hidden: boolean) => () => void>(() => () => {})
}))
vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  // `subscribeGuarded` is kept real: it is the guard the stores and the app
  // wiring subscribe through, and stubbing it would hide whether a subscription
  // is actually made.
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return {
    ...actual,
    invoke: bridge.invoke,
    subscribe: (name: string, callback: (payload: unknown) => void) => {
      bridge.listeners.set(name, callback)
      return () => bridge.listeners.delete(name)
    }
  }
})
vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: { hideWhile: bridge.hideWhile }
}))
const logger = vi.hoisted(() => ({ logRendererError: vi.fn(), logRendererDev: vi.fn() }))
vi.mock('$lib/system/renderer-logger', () => logger)

const instances: ReturnType<typeof mount>[] = []

function renderPalette(screenKey = 'actions') {
  const target = document.createElement('div')
  document.body.append(target)
  const instance = mount(CommandPalette, {
    target,
    props: {
      open: true,
      screenKey,
      actions: [],
      onSelect: vi.fn(),
      onClose: vi.fn()
    }
  })
  instances.push(instance)
  flushSync()
  return instance
}

/** Every node in a published frame, children included. */
function countNodes(nodes: readonly (NativeDockNode | string)[]): number {
  return nodes.reduce(
    (total, node) => total + (typeof node === 'string' ? 1 : countNodes(node.children) + 1),
    0
  )
}

function projection(): NativeDockRequest {
  const call = bridge.invoke.mock.calls.find(
    ([channel, , request]) => channel === 'browser:setDockOverlay' && request
  )
  if (!call) throw new Error('The spotlight published no native projection')
  return call[2] as NativeDockRequest
}

/**
 * One row of a thread screen: everything a real result draws, including the
 * vendor mark whose gradient lives in `<defs>`.
 */
function threadRow(index: number, providerName: string, providerId: string): ActionDefinition {
  return {
    id: `thread:${index}`,
    title: `Thread number ${index} about a long piece of work`,
    description: `Last message snippet for thread ${index}`,
    category: 'thread',
    source: { id: 'threads', label: 'Threads', kind: 'app', color: '#7c9aff' },
    shortcut: ['⌘', '1'],
    status: { label: 'Done', stage: 'done', variant: 'dot' },
    threadMeta: {
      working: false,
      harnessIds: ['pi'],
      providerName,
      providerId,
      modelId: 'claude-sonnet-5-5',
      branch: 'feature/a-branch-name',
      oven: null
    }
  }
}

function threadRows(count: number): ActionDefinition[] {
  const vendors = [
    { name: 'Google', id: 'gemini' },
    { name: 'Qwen', id: 'qwen' },
    { name: 'Anthropic', id: 'anthropic' }
  ]
  return Array.from({ length: count }, (_, index) => {
    const vendor = vendors[index % vendors.length]
    return threadRow(index, vendor.name, vendor.id)
  })
}

function renderThreadScreen(actions: ActionDefinition[], maxResults: number, screenKey: string) {
  const target = document.createElement('div')
  document.body.append(target)
  instances.push(
    mount(CommandPalette, {
      target,
      props: { open: true, screenKey, actions, maxResults, onSelect: vi.fn(), onClose: vi.fn() }
    })
  )
  flushSync()
}

beforeEach(() => {
  vi.useFakeTimers()
  bridge.invoke.mockClear()
  bridge.hideWhile.mockClear()
  logger.logRendererError.mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {}
  })
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({
      cancel() {},
      onfinish: null,
      effect: null,
      currentTime: 0,
      playState: 'finished'
    })
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 600, 400)
  )
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
})
afterEach(async () => {
  for (const instance of instances.splice(0)) await unmount(instance)
  document.body.replaceChildren()
  bridge.listeners.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
  Reflect.deleteProperty(Element.prototype, 'animate')
  vi.unstubAllGlobals()
})

describe('the Cmd+K spotlight keeps the browser up', () => {
  it('draws through the native projection so it never has to hide the page', async () => {
    renderPalette()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(request.modal).toBe(true)
    expect(request.nodes.length).toBeGreaterThan(0)
  })

  it('never suppresses the browser while it is open, before or after the host draws', async () => {
    renderPalette()
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(bridge.hideWhile).toHaveBeenCalled()
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
    bridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(2100)
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
  })

  it('keeps one query input focused across a screen change', async () => {
    const target = document.createElement('div')
    document.body.append(target)
    const harness = mount(SpotlightHarness, {
      target,
      props: { initialScreenKey: 'actions' }
    })
    instances.push(harness)
    flushSync()
    await vi.advanceTimersByTimeAsync(40)
    const before = document.querySelector<HTMLInputElement>('input[aria-label]')
    expect(before).not.toBeNull()
    before?.focus()
    expect(document.activeElement).toBe(before)
    harness.setScreenKey('files')
    flushSync()
    const after = document.querySelector<HTMLInputElement>('input[aria-label]')
    expect(after).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it('projects a full thread screen instead of falling back to the app window', async () => {
    // The regression this pins: the home screen projects (it holds a dozen
    // actions), so the browser stays up, and the moment a nested search screen
    // draws its rows the palette was refused for content it could not carry
    // (a vendor mark's `<defs>`) or for its size (a full screen of rows is
    // ~5,700 nodes, past the 4,096 a passive surface gets), which dropped it
    // into the app window and parked the page behind it.
    renderThreadScreen(threadRows(60), 60, 'all-threads')
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    expect(request.modal).toBe(true)
    expect(logger.logRendererError).not.toHaveBeenCalled()
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
  })

  it('projects the relocation picker at its full window', async () => {
    // A project's chats are drawn up to the picker's own window; the frame has
    // to stay inside the dialog budget or the picker hides the page.
    renderThreadScreen(threadRows(60), 60, 'relocation')
    await vi.advanceTimersByTimeAsync(40)
    const request = projection()
    // Every row, not just the first screenful: a frame that drops rows is a
    // picker the user cannot scroll.
    expect(countNodes(request.nodes)).toBeGreaterThan(4000)
    expect(logger.logRendererError).not.toHaveBeenCalled()
    expect(bridge.hideWhile.mock.calls.every((call) => call[2] === false)).toBe(true)
  })

  it('never writes a frame the validator refuses', async () => {
    // The controller validates every frame it publishes, so a published one is
    // a frame the main process accepts; a refused frame would be logged.
    renderThreadScreen(threadRows(60), 60, 'relocation')
    await vi.advanceTimersByTimeAsync(40)
    const rejected = bridge.invoke.mock.calls.filter(
      ([channel, argument]) => channel === 'browser:setDockOverlay' && argument === null
    )
    expect(rejected).toHaveLength(0)
  })
})
