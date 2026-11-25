// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import DockRow from '$lib/components/ui/DockRow.svelte'

vi.mock('$lib/components/ui/tooltip-manager.svelte', () => ({
  TOOLTIP_ID: 'tooltip-test',
  tooltipState: { visible: false, request: null },
  attachTitleTooltipDelegation: () => () => {},
  patchSuppressedTooltipTitle: () => false
}))

const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(true),
  listeners: new Map<string, (payload: unknown) => void>(),
  publish: vi.fn(),
  clear: vi.fn(),
  overlapsNative: vi.fn()
}))

vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: (name: string, callback: (payload: unknown) => void) => {
    bridge.listeners.set(name, callback)
    return () => bridge.listeners.delete(name)
  }
}))

vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: {
    canUseNativeDock: false,
    publishOcclusion: bridge.publish,
    clearOcclusion: bridge.clear,
    overlapsNative: bridge.overlapsNative
  }
}))

vi.mock('$lib/system/renderer-logger', () => ({
  logRendererError: vi.fn(),
  logRendererDev: vi.fn()
}))

const children = createRawSnippet(() => ({
  render: () => '<button type="button" data-test-chip>Docked chip</button>'
}))

const instances: Array<ReturnType<typeof mount>> = []

beforeEach(() => {
  bridge.invoke.mockReset()
  bridge.invoke.mockResolvedValue(true)
  bridge.listeners.clear()
  localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('innerWidth', 1200)
  vi.stubGlobal('innerHeight', 800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(20, 20, 220, 40)
  )
  // jsdom implements no pointer capture; the row captures the pointer while it
  // is dragged, so the calls have to exist even though nothing is captured.
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
})

afterEach(async () => {
  for (const instance of instances.splice(0)) await unmount(instance)
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Mount one docked chip row and return its floating root element. */
function renderRow(storageKey: string): HTMLElement {
  const target = document.createElement('div')
  document.body.append(target)
  instances.push(
    mount(DockRow, {
      target,
      props: { storageKey, label: 'Move docked panel', children }
    })
  )
  flushSync()
  const row = target.firstElementChild
  if (!(row instanceof HTMLElement)) throw new Error('The dock row did not render')
  return row
}

function press(row: HTMLElement): void {
  row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10 }))
  flushSync()
}

describe('docked chip stacking', () => {
  it('paints a row mounted later above the ones already docked', () => {
    const first = renderRow('dock-a')
    const second = renderRow('dock-b')
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex))
  })

  it('brings the pressed row in front of every other dock', () => {
    const first = renderRow('dock-a')
    const second = renderRow('dock-b')
    const third = renderRow('dock-c')
    expect(Number(third.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex))

    press(first)

    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(third.style.zIndex))
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex))
  })

  it('keeps the raised row in front until another dock is touched', () => {
    const first = renderRow('dock-a')
    const second = renderRow('dock-b')

    press(first)
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex))

    press(second)
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex))
  })

  it('leaves the band when it unmounts, so the next dock takes its place', async () => {
    const first = renderRow('dock-a')
    const second = renderRow('dock-b')
    press(first)
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex))

    await unmount(instances.shift()!)
    flushSync()

    // The remaining row is now the only dock in the band, so it sits at the
    // band's base instead of keeping the depth the removed row had pushed it to.
    expect(Number(second.style.zIndex)).toBe(50)
  })
})
