// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import DockableModal from '$lib/components/ui/DockableModal.svelte'
import DesignElementCommentPopover from '$lib/components/browser/DesignElementCommentPopover.svelte'
import { NativeDockController } from '$lib/native-dock-controller.svelte'
import type { NativeDockRequest } from '$shared/native-dock'
import { OVERLAY_ACK_TIMEOUT_MS } from '$shared/browser-overlay'
import { activateTopModalPrimaryAction } from '$lib/modal-primary-action.svelte'

const dockBridge = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(true),
  listeners: new Map<string, (payload: unknown) => void>()
}))
vi.mock('$lib/ipc.svelte', () => ({
  invoke: dockBridge.invoke,
  subscribe: (name: string, callback: (payload: unknown) => void) => {
    dockBridge.listeners.set(name, callback)
    return () => dockBridge.listeners.delete(name)
  }
}))
vi.mock('$lib/system/renderer-logger', () => ({ logRendererError: vi.fn() }))

const host = vi.hoisted(() => ({
  update: vi.fn(),
  restore: vi.fn(),
  dispose: vi.fn(),
  focusContent: vi.fn(),
  publish: vi.fn(),
  clear: vi.fn(),
  sent: vi.fn()
}))
vi.mock('$lib/native-floating-panel.svelte', () => ({
  NativeFloatingPanel: class {
    live = true
    failed = false
    portalTarget = null
    mount() {
      return host.dispose
    }
    update(...args: unknown[]) {
      host.update(...args)
    }
    restore() {
      host.restore()
    }
    focusContent() {
      host.focusContent()
    }
  }
}))
vi.mock('$lib/stores/browser-visibility.svelte', () => ({
  browserVisibility: {
    canUseNativeDock: true,
    publishOcclusion: host.publish,
    clearOcclusion: host.clear
  }
}))
vi.mock('$lib/stores/sidebar.svelte', () => ({ sidebarState: { docked: false, width: 0 } }))
vi.mock('$lib/keymap/keymap-state.svelte', () => ({
  keymapState: {
    matches: (id: string, event: KeyboardEvent) =>
      id.endsWith('close') || id === 'ui-close-modal'
        ? event.key === 'Escape'
        : event.key === 'Enter' && (event.metaKey || event.ctrlKey)
  }
}))
vi.mock('$lib/components/speech/VoiceInputButton.svelte', () => ({ default: () => {} }))
vi.mock('$lib/speech/speech-controller.svelte', () => ({
  speechController: { observeSent: host.sent }
}))
const instances: ReturnType<typeof mount>[] = []
const body = createRawSnippet(() => ({
  render: () =>
    '<div><textarea aria-label="Draft">Unsaved</textarea><button data-modal-primary>Apply</button></div>'
}))
const chip = createRawSnippet(() => ({
  render: () => '<button data-test-chip>Restore panel</button>'
}))
beforeEach(() => {
  Object.values(host).forEach((mock) => mock.mockClear())
  localStorage.clear()
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true
  })
})
afterEach(async () => {
  for (const instance of instances.splice(0)) await unmount(instance)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
})
function target() {
  const node = document.createElement('div')
  document.body.append(node)
  return node
}
function dockable(closable = true) {
  const minimized = new SvelteMap([['value', false]])
  const close = vi.fn()
  const minimize = vi.fn(() => minimized.set('value', true))
  instances.push(
    mount(DockableModal, {
      target: target(),
      props: {
        open: true,
        title: 'Panel',
        get minimized() {
          return minimized.get('value')!
        },
        closable,
        onClose: close,
        onMinimize: minimize,
        children: body,
        dock: chip
      }
    })
  )
  flushSync()
  return { minimized, close, minimize }
}
describe('dockable native panel', () => {
  it('keeps browser occlusion clear and preserves its editor through minimize and restore', () => {
    const state = dockable()
    const editor = document.querySelector('textarea')!
    expect(host.update).toHaveBeenCalledWith(true, true, expect.any(Object))
    expect(host.publish).not.toHaveBeenCalled()
    state.minimized.set('value', true)
    flushSync()
    expect(document.querySelector('[data-test-chip]')).not.toBeNull()
    expect(document.querySelector('textarea')).toBe(editor)
    expect(host.update).toHaveBeenCalledWith(true, false, expect.any(Object))
    state.minimized.set('value', false)
    flushSync()
    expect(document.querySelector('[data-test-chip]')).toBeNull()
    expect(document.querySelector('textarea')).toBe(editor)
    expect(editor.value).toBe('Unsaved')
    expect(host.publish).not.toHaveBeenCalled()
  })
  it('yields Escape and primary actions while minimized', () => {
    const state = dockable()
    state.minimized.set('value', true)
    flushSync()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(state.close).not.toHaveBeenCalled()
    expect(state.minimize).not.toHaveBeenCalled()
    expect(activateTopModalPrimaryAction()).toBe(false)
  })
  it('minimizes a non-closable panel on Escape and closes a closable one', async () => {
    const first = dockable(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    flushSync()
    expect(first.minimize).toHaveBeenCalledOnce()
    expect(first.close).not.toHaveBeenCalled()
    await unmount(instances.pop()!)
    const second = dockable(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(second.close).toHaveBeenCalledOnce()
  })
})
describe('design inspector floating comment', () => {
  function render() {
    const draft = vi.fn()
    const done = vi.fn()
    const close = vi.fn()
    const remove = vi.fn()
    instances.push(
      mount(DesignElementCommentPopover, {
        target: target(),
        props: {
          hostId: 'inspector',
          targetId: 'comment-test',
          scope: { kind: 'global' },
          comment: {
            referenceId: 'element-1',
            anchor: { x: 200, y: 100, width: 200, height: 40 },
            elementName: 'Save button',
            comment: 'Draft'
          },
          onDraftChange: draft,
          onDone: done,
          onRemove: remove,
          onClose: close
        }
      })
    )
    flushSync()
    return { draft, done, close, remove }
  }
  it('uses the native live host at the selected element without suppressing the browser', () => {
    render()
    expect(host.update).toHaveBeenCalledWith(true, true, {
      x: 100,
      y: 148,
      width: 400,
      height: 200
    })
    expect(host.focusContent).toHaveBeenCalled()
    expect(host.publish).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Comment on Save button'
    )
  })
  it('persists draft edits and sends Cmd+Enter to the same selected element', () => {
    const actions = render()
    const editor = document.querySelector('textarea')!
    editor.value = 'Changed'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    expect(actions.draft).toHaveBeenCalledWith('element-1', 'Changed')
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
    )
    expect(actions.done).toHaveBeenCalledWith('element-1', 'Changed')
    expect(host.sent).toHaveBeenCalledWith('comment-test', 'Changed')
  })
  it('moves the comment host with keyboard nudges while keeping its draft intact', () => {
    render()
    const editor = document.querySelector('textarea')!
    const handle = document.querySelector<HTMLButtonElement>('[data-popover-drag-handle]')!
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    )
    flushSync()
    expect(host.update).toHaveBeenLastCalledWith(true, true, {
      x: 112,
      y: 148,
      width: 400,
      height: 200
    })
    expect(document.querySelector('textarea')).toBe(editor)
    expect(editor.value).toBe('Draft')
    expect(host.publish).not.toHaveBeenCalled()
  })

  it('closes through the canonical comment control and releases the host', async () => {
    const actions = render()
    document.querySelector<HTMLButtonElement>('[aria-label="Close comment"]')!.click()
    expect(actions.close).toHaveBeenCalledOnce()
    await unmount(instances.pop()!)
    expect(host.dispose).toHaveBeenCalledOnce()
  })
})

describe('native dock acknowledgement for bounded and passive hosts', () => {
  let dockRoot: HTMLDivElement
  let controller: NativeDockController
  let releaseDock: () => void

  function mountDock(options: { panel?: boolean; passive?: boolean }): void {
    dockRoot = document.createElement('div')
    dockRoot.innerHTML = '<button>Restore panel</button>'
    document.body.append(dockRoot)
    controller = new NativeDockController(
      options.panel ? 'browser-tab-strip' : options.passive ? 'app-tooltip' : 'dock-test',
      () => {},
      () => ({ x: 0, y: 0, width: 200, height: 40 }),
      options.passive === true,
      options.panel
        ? { onHover: () => {}, onDismiss: () => {}, onCommit: () => {}, panel: true }
        : undefined
    )
    releaseDock = controller.mount(dockRoot)
    controller.update(true, { x: 0, y: 0, width: 200, height: 40 })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    dockBridge.listeners.clear()
    dockBridge.invoke.mockReset().mockResolvedValue(true)
    mountDock({ panel: true })
  })

  afterEach(() => {
    releaseDock()
    vi.useRealTimers()
  })

  async function projection(): Promise<NativeDockRequest> {
    await vi.advanceTimersByTimeAsync(40)
    const calls = dockBridge.invoke.mock.calls.filter(
      ([channel, , request]) => channel === 'browser:setDockOverlay' && request
    )
    if (!calls.length) throw new Error('The dock did not publish a native projection')
    return calls.at(-1)![2] as NativeDockRequest
  }

  it('gives the bounded panel host the generous window before it first answers', async () => {
    const request = await projection()
    // The old five second deadline would have expired well before this.
    await vi.advanceTimersByTimeAsync(5100)
    expect(controller.failed).toBe(false)
    dockBridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: request.id,
      revision: request.revision
    })
    expect(controller.ready).toBe(true)
  })

  it('holds the proven bounded panel host to the five second deadline', async () => {
    const first = await projection()
    dockBridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: first.id,
      revision: first.revision
    })
    dockRoot.querySelector('button')!.disabled = true
    const next = await projection()
    expect(next.revision).toBeGreaterThan(first.revision)
    await vi.advanceTimersByTimeAsync(5100)
    expect(controller.failed).toBe(true)
  })

  it('keeps the passive tooltip host on the generous window once proven', async () => {
    releaseDock()
    mountDock({ passive: true })
    const first = await projection()
    dockBridge.listeners.get('browser:overlay:dockDrawn')?.({
      id: first.id,
      revision: first.revision
    })
    dockRoot.querySelector('button')!.disabled = true
    const next = await projection()
    expect(next.revision).toBeGreaterThan(first.revision)
    await vi.advanceTimersByTimeAsync(2100)
    expect(controller.failed).toBe(false)
    await vi.advanceTimersByTimeAsync(OVERLAY_ACK_TIMEOUT_MS)
    expect(controller.failed).toBe(true)
  })
})
