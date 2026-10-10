import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { logRendererError } from '$lib/system/renderer-logger'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  NATIVE_DOCK_TAGS,
  NATIVE_DOCK_ATTRIBUTES,
  MAX_NATIVE_DOCK_NODES,
  nativeDockStyleAllowed,
  validateNativeDockImages,
  validateNativeDockRequest,
  type NativeDockNode,
  type NativeDockInteraction
} from '$shared/native-dock'
import type { BrowserViewBounds } from '$shared/ipc-contract'
import { OVERLAY_ACK_TIMEOUT_MS } from '$shared/browser-overlay'
import { supportsNativeModal } from '$lib/native-modal-capability'

/** One line naming why a native projection was refused, for the durable log. */
function describeRefusal(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** The original controls remain the owners of their actions and live updates. */
export class NativeDockController {
  ready = $state(false)
  failed = $state(false)
  private root: HTMLElement | null = null
  private bounds: BrowserViewBounds | null = null
  private revision = 0
  private frame: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private fields = new SvelteMap<string, HTMLInputElement | HTMLTextAreaElement>()
  private fieldIds = new WeakMap<Element, string>()
  private fieldVersions = new WeakMap<Element, number>()
  private buttons = new WeakMap<Element, string>()
  private actions = new SvelteMap<string, HTMLButtonElement>()
  private scrollTargets = new SvelteMap<string, HTMLElement>()
  private scrollIds = new WeakMap<Element, string>()
  private actionCounter = 0
  private imageCounter = 0
  private imageSources = new SvelteMap<string, string>()
  private deliveredImages = new SvelteSet<string>()
  private frameImages: Record<string, string> = {}
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
      onFailure?: (reason?: string) => void
      requireCompleteProjection?: boolean
      panel?: boolean
      onKey?: (event: KeyboardEvent) => boolean
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
        const firstDraw = !this.ready
        this.ready = true
        this.modalOptions?.onReady?.()
        // Publish readiness in the source before transferring native focus,
        // so its blur handler recognises the handover to its own modal.
        if (firstDraw && this.modalOptions && !this.modalOptions.panel)
          void invoke('browser:focusDockOverlay', this.id).catch(() => {})
      }
    })
    const unsubscribeKey = subscribe('browser:overlay:dockKey', (input) => {
      if (!this.active || input.id !== this.id || !this.modalOptions) return
      const event = new KeyboardEvent(input.type, {
        key: input.key,
        code: input.code,
        ctrlKey: input.control,
        shiftKey: input.shift,
        altKey: input.alt,
        metaKey: input.meta,
        repeat: input.isAutoRepeat,
        bubbles: true,
        cancelable: true
      })
      if (!this.modalOptions.onKey?.(event)) window.dispatchEvent(event)
    })
    const unsubscribeEvent = subscribe('browser:overlay:dockEvent', (report) => {
      if (!this.active || report.id !== this.id) return
      if (report.kind === 'field') {
        const field = this.fields.get(report.field)
        if (!field || !root.contains(field) || field.disabled || field.readOnly) return
        this.fieldVersions.set(field, report.version)
        field.value = report.value
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
        this.schedule()
        return
      }
      if (report.kind === 'fieldKey') {
        const field = this.fields.get(report.field)
        if (!field || !root.contains(field) || field.disabled) return
        const event = new KeyboardEvent(report.type, {
          key: report.key,
          code: report.code,
          ctrlKey: report.control,
          shiftKey: report.shift,
          altKey: report.alt,
          metaKey: report.meta,
          repeat: report.isAutoRepeat,
          bubbles: true,
          cancelable: true
        })
        field.dispatchEvent(event)
        return
      }
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
        if (button && root.contains(button) && !button.disabled) {
          button.dispatchEvent(new MouseEvent('mouseenter'))
          this.modalOptions?.onHover(button)
        }
        return
      }
      if (report.kind === 'scroll') {
        const target = this.scrollTargets.get(report.target)
        if (target && root.contains(target) && target.scrollTop !== report.top)
          target.scrollTop = report.top
        return
      }
      if (report.kind !== 'click' && report.kind !== 'context') {
        this.interact(report)
        return
      }
      const button = this.actions.get(report.action)
      if (button && root.contains(button) && !button.disabled) {
        const rect = button.getBoundingClientRect()
        button.dispatchEvent(
          new MouseEvent(report.kind === 'context' ? 'contextmenu' : 'click', {
            bubbles: true,
            cancelable: true,
            ctrlKey: report.control,
            shiftKey: report.shift,
            metaKey: report.meta,
            altKey: report.alt,
            button: report.kind === 'context' ? 2 : 0,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          })
        )
        return
      }
      // A press the source can no longer resolve   the row left the list, or the
      // action map moved between the overlay's paint and the press   must still
      // come down. Swallowing it leaves a modal covering the window with no way
      // to close it.
      this.modalOptions?.onDismiss()
    })
    const scrolled = (): void => this.schedule()
    root.addEventListener('scroll', scrolled, true)
    this.schedule()
    return () => {
      observer.disconnect()
      themeObserver.disconnect()
      unsubscribeAck()
      unsubscribeKey()
      unsubscribeEvent()
      root.removeEventListener('scroll', scrolled, true)
      clearTimeout(this.frame)
      clearTimeout(this.timer)
      this.root = null
      this.active = false
      this.actions.clear()
      this.fields.clear()
      this.scrollTargets.clear()
      this.imageSources.clear()
      this.deliveredImages.clear()
      this.frameImages = {}
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
      if (attribute.name === 'src' && attribute.value.startsWith('data:image/')) {
        let id = this.imageSources.get(attribute.value)
        if (!id) {
          id = `image-${++this.imageCounter}`
          this.imageSources.set(attribute.value, id)
        }
        this.frameImages[id] = attribute.value
        attributes['data-native-dock-image'] = id
        continue
      }
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
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      let id = this.fieldIds.get(node)
      if (!id) {
        id = `field-${++this.actionCounter}`
        this.fieldIds.set(node, id)
      }
      this.fields.set(id, node)
      attributes['data-native-dock-field'] = id
      if (node === document.activeElement) attributes['data-native-dock-focus'] = ''
      attributes['data-native-dock-value'] = node.value
      attributes['data-native-dock-version'] = String(this.fieldVersions.get(node) ?? 0)
      if (node.value && node.selectionStart === 0 && node.selectionEnd === node.value.length)
        attributes['data-native-dock-select'] = ''
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
    if (this.modalOptions?.requireCompleteProjection && !supportsNativeModal(this.root)) {
      this.refuse('its content cannot be projected completely')
      return
    }
    try {
      const rect = this.root.getBoundingClientRect()
      this.bounds = this.measuredBounds(rect.width, rect.height)
      this.actions.clear()
      this.fields.clear()
      this.scrollTargets.clear()
      this.nodeCount = 0
      this.frameImages = {}
      const nodes = (this.modalOptions ? [this.root] : [...this.root.childNodes])
        .map((child) => this.project(child))
        .filter((child) => child !== null)
      const content = {
        bounds: this.bounds,
        passive: this.passive,
        modal: Boolean(this.modalOptions && !this.modalOptions.panel),
        panel: Boolean(this.modalOptions?.panel),
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
      validateNativeDockImages(this.frameImages)
      const liveIds = new SvelteSet(Object.keys(this.frameImages))
      for (const [source, id] of this.imageSources) {
        if (!liveIds.has(id)) {
          this.imageSources.delete(source)
          this.deliveredImages.delete(id)
        }
      }
      const images = Object.fromEntries(
        Object.entries(this.frameImages).filter(([id]) => !this.deliveredImages.has(id))
      )
      this.signature = signature
      const request = validateNativeDockRequest({
        ...content,
        images,
        id: this.id,
        revision: ++this.revision
      })
      clearTimeout(this.timer)
      // A modal shares the always-warm full-window overlay, so two seconds is
      // enough for it to prove it drew. A bounded panel host is loaded while the
      // browser view is up, but a reveal can still land while that load is in
      // flight, and nothing is drawn in the app window while it waits: five
      // seconds bounds that wait without turning a slow start into a fallback.
      this.timer = setTimeout(
        () => this.refuse('its host never confirmed the panel it was given'),
        this.passive ? OVERLAY_ACK_TIMEOUT_MS : this.modalOptions?.panel ? 5000 : 2000
      )
      void invoke('browser:setDockOverlay', this.id, request)
        .then((accepted) => {
          if (!accepted && this.active) this.refuse('its host could not take the projection')
          if (accepted && this.active) {
            for (const id of Object.keys(images)) {
              if (id in this.frameImages) this.deliveredImages.add(id)
            }
          }
        })
        .catch((error: unknown) => {
          if (this.active) this.refuse(describeRefusal(error))
        })
    } catch (error) {
      logRendererError('The native dock could not project its controls', error)
      this.refuse(describeRefusal(error))
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

  private refuse(reason?: string): void {
    this.failed = true
    if (reason)
      logRendererError(`The native dock '${this.id}' fell back to the app window: ${reason}`)
    this.modalOptions?.onFailure?.(reason)
    this.ready = false
    this.active = false
    clearTimeout(this.timer)
    void invoke('browser:setDockOverlay', this.id, null).catch(() => {})
  }
}
