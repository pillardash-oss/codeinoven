import { SvelteMap } from 'svelte/reactivity'
import { logRendererError } from '$lib/system/renderer-logger'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  NATIVE_DOCK_TAGS,
  NATIVE_DOCK_ATTRIBUTES,
  MAX_NATIVE_DOCK_NODES,
  nativeDockStyleAllowed,
  validateNativeDockRequest,
  type NativeDockNode,
  type NativeDockInteraction
} from '$shared/native-dock'
import type { BrowserViewBounds } from '$shared/ipc-contract'
import { OVERLAY_ACK_TIMEOUT_MS } from '$shared/browser-overlay'

/** The original controls remain the owners of their actions and live updates. */
export class NativeDockController {
  ready = $state(false)
  failed = $state(false)
  private root: HTMLElement | null = null
  private bounds: BrowserViewBounds | null = null
  private revision = 0
  private frame: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private buttons = new WeakMap<Element, string>()
  private actions = new SvelteMap<string, HTMLButtonElement>()
  private scrollTargets = new SvelteMap<string, HTMLElement>()
  private scrollIds = new WeakMap<Element, string>()
  private actionCounter = 0
  private signature = ''
  private active = false
  constructor(
    private id: string,
    private interact: (report: NativeDockInteraction) => void,
    private measuredBounds: (width: number, height: number) => BrowserViewBounds,
    private passive = false,
    private modalOptions?: {
      onHover: (button: HTMLButtonElement) => void
      onDismiss: () => void
      onCommit: (key: string) => void
      onReady?: () => void
      onFailure?: () => void
    }
  ) {}

  mount(root: HTMLElement): () => void {
    this.root = root
    const observer = new MutationObserver(() => this.schedule())
    const themeObserver = new MutationObserver(() => this.schedule())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    })
    const unsubscribeAck = subscribe('browser:overlay:dockDrawn', (ack) => {
      if (this.active && ack.id === this.id && ack.revision === this.revision) {
        clearTimeout(this.timer)
        this.ready = true
        this.modalOptions?.onReady?.()
      }
    })
    const unsubscribeEvent = subscribe('browser:overlay:dockEvent', (report) => {
      if (!this.active || report.id !== this.id) return
      if (report.kind === 'dismiss') {
        this.modalOptions?.onDismiss()
        return
      }
      if (report.kind === 'commit') {
        this.modalOptions?.onCommit(report.key)
        return
      }
      if (report.kind === 'hover') {
        const button = this.actions.get(report.action)
        if (button && root.contains(button) && !button.disabled) this.modalOptions?.onHover(button)
        return
      }
      if (report.kind === 'scroll') {
        const target = this.scrollTargets.get(report.target)
        if (target && root.contains(target) && target.scrollTop !== report.top)
          target.scrollTop = report.top
        return
      }
      if (report.kind !== 'click') {
        this.interact(report)
        return
      }
      const button = this.actions.get(report.action)
      if (button && root.contains(button) && !button.disabled) button.click()
    })
    const scrolled = (): void => this.schedule()
    root.addEventListener('scroll', scrolled, true)
    this.schedule()
    return () => {
      observer.disconnect()
      themeObserver.disconnect()
      unsubscribeAck()
      unsubscribeEvent()
      root.removeEventListener('scroll', scrolled, true)
      clearTimeout(this.frame)
      clearTimeout(this.timer)
      this.root = null
      this.active = false
      this.actions.clear()
      this.scrollTargets.clear()
      void invoke('browser:setDockOverlay', this.id, null).catch(() => {})
    }
  }

  update(enabled: boolean, bounds: BrowserViewBounds): void {
    this.bounds = bounds
    if (!enabled || this.failed) {
      if (this.active) void invoke('browser:setDockOverlay', this.id, null).catch(() => {})
      this.active = false
      this.ready = false
      this.signature = ''
      clearTimeout(this.timer)
      return
    }
    this.active = true
    this.schedule()
  }

  private schedule(): void {
    if (this.frame || !this.active || !this.root) return
    this.frame = setTimeout(() => {
      this.frame = undefined
      this.publish()
    }, 16)
  }

  private nodeCount = 0
  private project(node: Node, depth = 0): NativeDockNode | string | null {
    if (++this.nodeCount > (this.modalOptions ? MAX_NATIVE_DOCK_NODES : 512) || depth > 24)
      throw new TypeError('Native dock tree is too large')
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (!(node instanceof Element) || !NATIVE_DOCK_TAGS.has(node.localName)) return null
    // Picker rows also mount their regular sidebar markup, hidden. It is not
    // part of the palette and must not spend its projection budget.
    if (this.modalOptions && node.classList.contains('hidden')) return null
    const attributes: Record<string, string> = {}
    for (const attribute of node.attributes) {
      if (attribute.name !== 'style' && NATIVE_DOCK_ATTRIBUTES.has(attribute.name))
        attributes[attribute.name] = attribute.value
    }
    if (node instanceof HTMLElement || node instanceof SVGElement) {
      const sizing = [
        'width',
        'height',
        'font-size',
        'color',
        'background',
        'background-color',
        'border-top-color',
        'border-right-color'
      ]
        .map((property) => {
          const value = node.style.getPropertyValue(property)
          const declaration = `${property}: ${value};`
          return value && nativeDockStyleAllowed(declaration) ? declaration : ''
        })
        .join(' ')
      if (sizing.trim()) attributes.style = sizing.trim()
    }
    if (
      this.modalOptions &&
      node instanceof HTMLElement &&
      (node.matches('.overflow-auto, .overflow-y-auto, .overflow-scroll, .overflow-y-scroll') ||
        ['auto', 'scroll'].includes(node.style.overflowY))
    ) {
      let id = this.scrollIds.get(node)
      if (!id) {
        id = `scroll-${++this.actionCounter}`
        this.scrollIds.set(node, id)
      }
      attributes['data-native-dock-scroll'] = id
      attributes['data-native-dock-scroll-top'] = String(node.scrollTop)
      // This child window excludes the header, so its vh differs. Preserve the
      // canonical scroll frame's height rather than shrinking it a second time.
      const height = node.getBoundingClientRect().height
      attributes.style = `${attributes.style ?? ''} height: ${height}px; max-height: ${height}px;`
      this.scrollTargets.set(id, node)
    }
    if (node instanceof HTMLButtonElement && !node.closest('[data-native-dock-handle]')) {
      let action = this.buttons.get(node)
      if (!action) {
        action = `action-${++this.actionCounter}`
        this.buttons.set(node, action)
      }
      attributes['data-native-dock-action'] = action
      this.actions.set(action, node)
    }
    return {
      tag: node.localName,
      attributes,
      children: [...node.childNodes]
        .map((child) => this.project(child, depth + 1))
        .filter((child) => child !== null)
    }
  }

  private publish(): void {
    if (!this.root || !this.bounds || !this.active) return
    try {
      const rect = this.root.getBoundingClientRect()
      this.bounds = this.measuredBounds(rect.width, rect.height)
      this.actions.clear()
      this.scrollTargets.clear()
      this.nodeCount = 0
      const nodes = (this.modalOptions ? [this.root] : [...this.root.childNodes])
        .map((child) => this.project(child))
        .filter((child) => child !== null)
      const content = {
        bounds: this.bounds,
        passive: this.passive,
        modal: Boolean(this.modalOptions),
        typography: this.typography(),
        selectedAction:
          [...this.actions].find(
            ([, button]) => button.getAttribute('aria-selected') === 'true'
          )?.[0] ?? null,
        nodes,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      }
      const signature = JSON.stringify(content)
      if (signature === this.signature) return
      this.signature = signature
      const request = validateNativeDockRequest({
        ...content,
        id: this.id,
        revision: ++this.revision
      })
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.refuse(), this.passive ? OVERLAY_ACK_TIMEOUT_MS : 2000)
      void invoke('browser:setDockOverlay', this.id, request)
        .then((accepted) => {
          if (!accepted && this.active) this.refuse()
        })
        .catch(() => {
          if (this.active) this.refuse()
        })
    } catch (error) {
      logRendererError('The native dock could not project its controls', error)
      this.refuse()
    }
  }

  private typography(): NonNullable<import('$shared/native-dock').NativeDockRequest['typography']> {
    const style = getComputedStyle(document.documentElement)
    return {
      fontFamily: style.getPropertyValue('--font-app').trim(),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseFloat(style.fontWeight)
    }
  }

  private refuse(): void {
    this.failed = true
    this.modalOptions?.onFailure?.()
    this.ready = false
    this.active = false
    clearTimeout(this.timer)
    void invoke('browser:setDockOverlay', this.id, null).catch(() => {})
  }
}
