// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import NativeToastSurface from '$lib/components/ui/NativeToastSurface.svelte'
import type { ToastOverlayRequestStack } from '$shared/browser-overlay'
import type { ExternalToast } from 'svelte-sonner'

const bridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ stack: null }),
  listeners: new Map<string, (payload: unknown) => void>(),
  draw: vi.fn<(title: string, options: ExternalToast) => number | string>(() => 'toast-1'),
  dismiss: vi.fn()
}))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: bridge.invoke,
  subscribe: (name: string, callback: (payload: unknown) => void) => {
    bridge.listeners.set(name, callback)
    return () => bridge.listeners.delete(name)
  }
}))
vi.mock('$lib/system/renderer-logger', () => ({ logRendererDev: vi.fn() }))
vi.mock('svelte-sonner', async (original) => ({
  ...(await original<typeof import('svelte-sonner')>()),
  toast: {
    success: bridge.draw,
    error: bridge.draw,
    warning: bridge.draw,
    info: bridge.draw,
    loading: bridge.draw,
    message: bridge.draw,
    dismiss: bridge.dismiss
  }
}))
let instance: ReturnType<typeof mount> | undefined
const stack: ToastOverlayRequestStack = {
  revision: 1,
  theme: 'dark',
  toasts: [{ id: 'toast-1', kind: 'success', title: 'Saved', action: { label: 'Open' } }]
}
beforeEach(() => {
  bridge.invoke.mockClear()
  bridge.draw.mockClear()
  bridge.dismiss.mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const target = document.createElement('div')
  document.body.append(target)
  instance = mount(NativeToastSurface, { target })
  flushSync()
})
afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  document.body.replaceChildren()
  bridge.listeners.clear()
  vi.unstubAllGlobals()
})
async function apply(value: ToastOverlayRequestStack) {
  bridge.listeners.get('browser:overlay:stack')?.(value)
  flushSync()
  await Promise.resolve()
  flushSync()
}
describe('native Sonner stack bridge', () => {
  it('acknowledges drawn revisions without resetting unchanged toast timers', async () => {
    await apply(stack)
    expect(bridge.draw).toHaveBeenCalledOnce()
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDrawn', {
      revision: 1,
      drawn: ['toast-1']
    })
    await apply({ ...stack, revision: 2 })
    expect(bridge.draw).toHaveBeenCalledOnce()
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayDrawn', {
      revision: 2,
      drawn: ['toast-1']
    })
    await apply({ ...stack, revision: 3, toasts: [] })
    expect(bridge.dismiss).toHaveBeenCalledWith('toast-1')
  })
  it('routes native action and dismissal back to the source toast', async () => {
    await apply(stack)
    const options = bridge.draw.mock.calls[0][1]
    const event = new MouseEvent('click', { cancelable: true }) as MouseEvent & {
      currentTarget: HTMLButtonElement
    }
    Object.defineProperty(event, 'currentTarget', { value: document.createElement('button') })
    if (options.action && typeof options.action === 'object' && 'onClick' in options.action)
      options.action.onClick(event)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayInteract', {
      id: 'toast-1',
      interaction: 'action'
    })
    options.onDismiss?.({ id: 'toast-1', title: 'Saved', type: 'success' })
    expect(bridge.invoke).toHaveBeenCalledWith('browser:overlayInteract', {
      id: 'toast-1',
      interaction: 'dismiss'
    })
  })
})
