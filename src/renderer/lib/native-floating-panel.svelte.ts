import { flushSync, mount, unmount } from 'svelte'
import type { Attachment } from 'svelte/attachments'
import type { NativeFloatingPanelBounds } from '$shared/native-floating-panel'
import { invoke } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import {
  findFirstTextField,
  findPanelPrimaryAction,
  isFocusableTarget
} from '$lib/modal-primary-action.svelte'
import NativeFloatingEventRoot from '$lib/components/ui/NativeFloatingEventRoot.svelte'
import { terminalEntryForHost } from '$lib/terminal/host-registry'

/** Hosts the original component tree, not an inert copy of editor/terminal markup. */
export class NativeFloatingPanel {
  live = $state(false)
  failed = $state(false)
  portalTarget = $state.raw<HTMLElement | null>(null)

  private root: HTMLElement | null = null
  private anchor: Comment | null = null
  private popup: Window | null = null
  private eventRoot: Record<string, unknown> | null = null
  private hostContainer: HTMLElement | null = null
  private cleanupHost: (() => void) | null = null
  private bounds: NativeFloatingPanelBounds = { x: 0, y: 0, width: 1, height: 1 }
  private visible = false
  private enabled = false
  private disposed = false
  private creating: Promise<void> | null = null
  private frame: ReturnType<typeof setTimeout> | null = null
  private sending = false
  private dirty = false
  private origin = { x: 0, y: 0 }
  private movedFocus: HTMLElement | null = null
  private focusPending = false

  constructor(readonly id: string) {}

  /** A newly opened editor in an already-live panel needs its caret activated. */
  focusContent(): void {
    this.focusPending = true
    this.schedule()
  }

  mount(root: HTMLElement): () => void {
    this.disposed = false
    this.failed = false
    this.root = root
    this.anchor = document.createComment('native-floating-panel')
    root.before(this.anchor)
    return () => this.dispose()
  }

  update(enabled: boolean, visible: boolean, bounds: NativeFloatingPanelBounds): void {
    const visibilityChanged = this.visible !== visible
    this.enabled = enabled
    this.visible = visible
    this.bounds = bounds
    if (visibilityChanged) this.focusPending = visible
    if (!enabled) {
      this.restore()
      void this.hide()
      return
    }
    if (!this.root || this.failed || this.disposed) return
    if (!this.popup) {
      if (visible && !this.creating) {
        this.creating = this.create().finally(() => {
          this.creating = null
        })
      }
      return
    }
    if (!this.live) this.moveIntoHost()
    this.schedule(visibilityChanged)
  }

  /** Must run before Svelte removes the original block's node range. */
  restore(): void {
    if (this.root && this.anchor?.parentNode && this.root.ownerDocument !== document) {
      const focused = this.focusedElement()
      const hadFocus = this.root.ownerDocument.hasFocus()
      this.anchor.after(this.root)
      this.root.removeAttribute('data-native-floating-panel')
      this.notifyDocumentChange()
      // Adoption clears activeElement even though the same editor stays mounted.
      // Only transfer window focus when the child actually owned it.
      if (!this.disposed && this.visible && focused && hadFocus) {
        window.focus()
        focused.focus({ preventScroll: true })
      }
    }
    this.live = false
    this.portalTarget = null
    this.movedFocus = null
    this.focusPending = false
  }

  private async create(): Promise<void> {
    try {
      const token = await invoke('app:prepareFloatingPanel', this.id, this.bounds)
      if (this.disposed || !this.enabled) {
        await invoke('app:releaseFloatingPanel', this.id)
        return
      }
      const popup = window.open('about:blank', token)
      if (!popup) throw new Error('The native floating panel window was refused')
      this.popup = popup
      this.origin = { x: this.bounds.x, y: this.bounds.y }
      // about:blank inherits the app origin. No app bundle or second editor is loaded.
      const target = popup.document.createElement('div')
      popup.document.body.append(target)
      const attached: Attachment<HTMLDivElement> = (container) => {
        this.hostContainer = container
        this.moveIntoHost(container)
      }
      this.eventRoot = mount(NativeFloatingEventRoot, { target, props: { attach: attached } })
      flushSync()
      await this.initializeDocument(popup)
      if (this.disposed) return
      if (!this.enabled) this.restore()
      this.schedule(true)
    } catch (error) {
      if (this.disposed) return
      this.restore()
      this.failed = true
      this.cleanupHost?.()
      this.cleanupHost = null
      if (this.eventRoot) void unmount(this.eventRoot)
      this.eventRoot = null
      this.hostContainer = null
      this.popup = null
      logRendererError('The live native floating panel could not open', error)
      await invoke('app:releaseFloatingPanel', this.id).catch(() => {})
    }
  }

  private moveIntoHost(container = this.hostContainer): void {
    if (!container || !this.root || !this.enabled) return
    if (this.root.parentNode !== container) {
      this.movedFocus = this.focusedElement()
      container.append(this.root)
      this.notifyDocumentChange()
      this.movedFocus?.focus({ preventScroll: true })
      this.focusPending = this.visible
    }
    this.root.setAttribute('data-native-floating-panel', '')
    this.live = true
    this.portalTarget = container
  }

  private focusedElement(): HTMLElement | null {
    const active = this.root?.ownerDocument.activeElement
    // The live controls were created in the app realm, even after adoption.
    return active instanceof HTMLElement && this.root?.contains(active) ? active : null
  }

  private focusExpandedPanel(): void {
    const root = this.root
    if (!root || !this.popup || !this.visible || !this.live || !this.enabled || this.disposed)
      return
    const isContentTarget = (element: HTMLElement | null): element is HTMLElement =>
      element !== null &&
      root.contains(element) &&
      !element.closest('[data-native-dock-handle], [data-popover-drag-handle]') &&
      !element.matches(':disabled') &&
      isFocusableTarget(element)
    const active = this.focusedElement()
    const preserved = isContentTarget(active)
      ? active
      : isContentTarget(this.movedFocus)
        ? this.movedFocus
        : null
    const target = preserved ?? findFirstTextField(root) ?? findPanelPrimaryAction(root) ?? root
    if (target === root && !root.hasAttribute('tabindex')) root.tabIndex = -1
    // Main uses showInactive so geometry updates cannot steal focus. Expansion
    // is the one point where this controller activates the native window.
    this.popup.focus()
    target.focus({ preventScroll: true })
    if (target === root) {
      const host = root.querySelector<HTMLElement>('.terminal-host')
      if (host) terminalEntryForHost(host)?.term.focus()
    }
    this.movedFocus = null
  }

  private notifyDocumentChange(): void {
    for (const element of this.root?.querySelectorAll('[data-floating-document]') ?? []) {
      element.dispatchEvent(new Event('native-floating-document-change'))
    }
  }

  private async initializeDocument(popup: Window): Promise<void> {
    const nativeDocument = popup.document
    const base = document.createElement('base')
    base.href = document.baseURI
    nativeDocument.head.append(base)
    const styles = document.createElement('div')
    nativeDocument.head.append(styles)
    const css = document.createElement('style')
    css.textContent = `html,body{margin:0!important;width:100%;height:100%;overflow:hidden!important;background:transparent!important;pointer-events:auto!important} [data-native-floating-panel]{position:absolute!important;left:var(--floating-x,0px)!important;top:var(--floating-y,0px)!important;opacity:1!important} [data-native-floating-panel] button:not(:disabled):not([data-popover-drag-handle]){cursor:pointer} [data-native-floating-panel].invisible{visibility:hidden} @media(prefers-reduced-motion:no-preference){[data-native-floating-panel]{animation:native-floating-enter 140ms ease-out}} @keyframes native-floating-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`
    nativeDocument.head.append(css)
    let stylesheetFrame: ReturnType<typeof setTimeout> | null = null
    const syncStyles = (): void => {
      nativeDocument.documentElement.className = document.documentElement.className
      nativeDocument.documentElement.style.cssText = document.documentElement.style.cssText
      for (const attribute of document.documentElement.attributes) {
        if (attribute.name.startsWith('data-')) {
          nativeDocument.documentElement.setAttribute(attribute.name, attribute.value)
        }
      }
      styles.replaceChildren(
        ...Array.from(document.head.querySelectorAll('style,link[rel="stylesheet"]')).map((node) =>
          node.cloneNode(true)
        )
      )
    }
    syncStyles()
    const styleObserver = new MutationObserver(() => {
      if (stylesheetFrame) return
      stylesheetFrame = setTimeout(() => {
        stylesheetFrame = null
        syncStyles()
      }, 16)
    })
    styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
    styleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    })

    // Libraries mounted in the source realm still have document-level terminal
    // selection listeners. Relay their document phase without replaying Svelte's
    // delegated control handlers, which already ran in the native event root.
    const relayMouse = (event: MouseEvent): void => {
      const forwarded = new MouseEvent(event.type, event)
      Object.defineProperty(forwarded, 'target', { value: event.target })
      document.dispatchEvent(forwarded)
    }
    const relayKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key !== 'Escape') return
      const forwarded = new KeyboardEvent(event.type, event)
      Object.defineProperty(forwarded, 'target', { value: event.target })
      window.dispatchEvent(forwarded)
      if (forwarded.defaultPrevented) event.preventDefault()
    }
    const mouseEvents = ['mousedown', 'mousemove', 'mouseup', 'click', 'contextmenu'] as const
    for (const type of mouseEvents) nativeDocument.addEventListener(type, relayMouse)
    nativeDocument.addEventListener('keydown', relayKey)
    nativeDocument.addEventListener('keyup', relayKey)
    // Use the app's existing tooltip delegation and native tooltip host, with
    // pointer coordinates translated from the child into the app viewport.
    const relayPointer = (event: PointerEvent): void => {
      const forwarded = new PointerEvent(event.type, {
        ...event,
        clientX: this.origin.x + event.clientX,
        clientY: this.origin.y + event.clientY,
        relatedTarget: event.relatedTarget
      })
      Object.defineProperty(forwarded, 'target', { value: event.target })
      window.dispatchEvent(forwarded)
    }
    const pointerEvents = ['pointerover', 'pointermove', 'pointerout', 'pointerdown'] as const
    for (const type of pointerEvents) nativeDocument.addEventListener(type, relayPointer)
    const geometryObserver = new MutationObserver(() => this.schedule())
    if (this.portalTarget)
      geometryObserver.observe(this.portalTarget, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'class']
      })
    const beforeUnload = (): void => this.restore()
    popup.addEventListener('beforeunload', beforeUnload)
    this.cleanupHost = () => {
      styleObserver.disconnect()
      geometryObserver.disconnect()
      if (stylesheetFrame) clearTimeout(stylesheetFrame)
      for (const type of mouseEvents) nativeDocument.removeEventListener(type, relayMouse)
      nativeDocument.removeEventListener('keydown', relayKey)
      nativeDocument.removeEventListener('keyup', relayKey)
      for (const type of pointerEvents) nativeDocument.removeEventListener(type, relayPointer)
      popup.removeEventListener('beforeunload', beforeUnload)
    }
    const links = Array.from(styles.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    await Promise.all(
      links.map((link) =>
        link.sheet
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              // HMR can replace a link before it emits load. Never hold the
              // live panel indefinitely on a detached stylesheet.
              const finish = (): void => {
                clearTimeout(timer)
                link.removeEventListener('load', finish)
                link.removeEventListener('error', finish)
                resolve()
              }
              const timer = setTimeout(finish, 200)
              link.addEventListener('load', finish, { once: true })
              link.addEventListener('error', finish, { once: true })
            })
      )
    )
  }

  private schedule(immediate = false): void {
    this.dirty = true
    if (this.sending || this.disposed) return
    if (immediate) {
      if (this.frame) clearTimeout(this.frame)
      this.frame = null
      void this.publish()
      return
    }
    if (this.frame) return
    // Chromium pauses the app's animation frames when a native browser page
    // occludes it. A bounded one-shot timer still publishes the child geometry.
    this.frame = setTimeout(() => {
      this.frame = null
      void this.publish()
    }, 16)
  }

  private async publish(): Promise<void> {
    if (this.disposed || !this.popup || !this.enabled) return
    this.sending = true
    this.dirty = false
    const bounds = { ...this.bounds }
    // A picker portaled by the panel shares the same live root. Grow the native
    // window only while it is open, rather than ever capturing the whole app.
    if (this.portalTarget) {
      for (const element of this.portalTarget.children) {
        if (
          element === this.root ||
          !(element instanceof HTMLElement) ||
          !element.checkVisibility()
        )
          continue
        const rect = element.getBoundingClientRect()
        const left = this.origin.x + rect.left
        const top = this.origin.y + rect.top
        const right = Math.max(bounds.x + bounds.width, this.origin.x + rect.right)
        const bottom = Math.max(bounds.y + bounds.height, this.origin.y + rect.bottom)
        bounds.x = Math.max(0, Math.min(bounds.x, left))
        bounds.y = Math.max(0, Math.min(bounds.y, top))
        bounds.width = Math.min(window.innerWidth - bounds.x, right - bounds.x)
        bounds.height = Math.min(window.innerHeight - bounds.y, bottom - bounds.y)
      }
    }
    this.origin = { x: bounds.x, y: bounds.y }
    const x = `${this.bounds.x - bounds.x}px`
    const y = `${this.bounds.y - bounds.y}px`
    if (this.root?.style.getPropertyValue('--floating-x') !== x)
      this.root?.style.setProperty('--floating-x', x)
    if (this.root?.style.getPropertyValue('--floating-y') !== y)
      this.root?.style.setProperty('--floating-y', y)
    try {
      const visible = this.visible && this.live
      const updated = await invoke('app:updateFloatingPanel', this.id, bounds, visible)
      if (updated && visible && this.focusPending && this.enabled && !this.disposed) {
        this.focusPending = false
        this.focusExpandedPanel()
      }
    } catch (error) {
      logRendererError('The native floating panel could not update', error)
    } finally {
      this.sending = false
      if (this.dirty) this.schedule()
    }
  }

  private async hide(): Promise<void> {
    if (!this.popup || this.disposed) return
    await invoke('app:updateFloatingPanel', this.id, this.bounds, false).catch(() => {})
  }

  private dispose(): void {
    this.disposed = true
    if (this.frame) clearTimeout(this.frame)
    this.frame = null
    this.restore()
    this.cleanupHost?.()
    this.cleanupHost = null
    if (this.eventRoot) void unmount(this.eventRoot)
    this.eventRoot = null
    this.hostContainer = null
    this.anchor?.remove()
    this.root = null
    this.popup = null
    void invoke('app:releaseFloatingPanel', this.id).catch(() => {})
  }
}
