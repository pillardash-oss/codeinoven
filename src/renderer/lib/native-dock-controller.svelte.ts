import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { logRendererDev, logRendererError } from '$lib/system/renderer-logger'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  NATIVE_DOCK_TAGS,
  NATIVE_DOCK_ATTRIBUTES,
  NATIVE_DOCK_STYLE_PROPERTIES,
  MAX_NATIVE_DOCK_NODES,
  MAX_NATIVE_DOCK_IMAGE_SOURCE_CHARS,
  MAX_NATIVE_DOCK_IMAGES,
  nativeDockColor,
  nativeDockStyleAllowed,
  validateNativeDockImages,
  validateNativeDockRequest,
  type NativeDockNode,
  type NativeDockInteraction
} from '$shared/native-dock'
import type { BrowserViewBounds } from '$shared/ipc-contract'
import { OVERLAY_ACK_TIMEOUT_MS } from '$shared/browser-overlay'
import { nativeModalRefusal } from '$lib/native-modal-capability'

/**
 * Everything that answers a pointer.
 *
 * The projection used to hand an identity only to `<button>`, which is the
 * switcher's own shape and almost nothing else's: a command palette row is a
 * `div[role=option]`, a menu entry is a `div[role=menuitem]`, and a card that
 * acts as a link is a `div[role=button]`. Every one of them was inert in the
 * native document, which is why hover, the pointer cursor and the press itself
 * worked on some dialogs and not others.
 */
const DOCK_ACTION_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  'select',
  'label[for]',
  '[role="button"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[data-modal-primary]',
  '[data-modal-dismiss]'
].join(',')

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

/**
 * The square an oversized icon is copied into before the dock carries it.
 *
 * Icons are drawn at 12 to 16 pixels, so 64 is generous even on a 2x display,
 * and it is small enough that the copy is a fraction of the budget. See
 * `copyNativeDockImage`.
 */
const NATIVE_DOCK_IMAGE_EDGE = 64

/**
 * Re-encode an oversized icon at the size it is drawn.
 *
 * Canvas is the only thing in the renderer that re-encodes an image without
 * asking the main process to, and a PNG of a 64px square is always inside the
 * dock's per-image budget. Returns null when the image never decoded, which
 * leaves the icon blank rather than refusing the panel.
 */
function copyNativeDockImage(image: HTMLImageElement): string | null {
  const source = Math.max(image.naturalWidth, image.naturalHeight)
  if (source <= 0) return null
  const scale = Math.min(1, NATIVE_DOCK_IMAGE_EDGE / source)
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

/**
 * A grab affordance, not a control.
 *
 * The dock chip's grip is a button, and a press on it drags the chip. Giving it
 * an action would turn its press into a click and take the drag away from it, so
 * it is identified as a handle instead (see `data-native-dock-handle`).
 */
const DOCK_GRAB_SELECTOR = '[data-popover-drag-handle]'

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
  private actions = new SvelteMap<string, HTMLElement>()
  private focusKeys = new WeakMap<Element, string>()
  private focusables = new SvelteMap<string, HTMLElement>()
  private scrollTargets = new SvelteMap<string, HTMLElement>()
  private scrollIds = new WeakMap<Element, string>()
  /**
   * The position this controller last wrote onto a scroll host to mirror the
   * overlay's own scrolling.
   *
   * The overlay owns the gesture   it holds the pointer and the keyboard   and
   * the app only follows it so hit-testing rects stay true. That mirror is a
   * scroll the overlay already made, so publishing it would re-project the whole
   * panel to echo a position the overlay is at or past, and every frame of the
   * echo dragged the live gesture backwards. Recognising the mirror keeps the
   * scroll path one-way: a gesture drives the app, never a repaint.
   */
  private mirroredScrolls = new WeakMap<HTMLElement, number>()
  private actionCounter = 0
  private imageCounter = 0
  private imageSources = new SvelteMap<string, string>()
  private deliveredImages = new SvelteSet<string>()
  private frameImages: Record<string, string> = {}
  /**
   * The bounded copy made for each oversized icon, keyed by its full source.
   *
   * Kept for the life of the mount so reopening a panel repaints a megabyte
   * icon from the copy rather than decoding it again.
   */
  private imageCopies = new SvelteMap<string, string>()
  /** Sources whose copy is being decoded, so one icon is only queued once. */
  private imageCopyPending = new SvelteSet<string>()
  /** Sources that never decoded, so a broken icon is not retried every frame. */
  private imageCopyFailed = new SvelteSet<string>()
  /** Distinct original sources admitted to the frame being built. */
  private frameImageSources = new SvelteSet<string>()
  private signature = ''
  /**
   * Whether this dock's host has ever answered for it.
   *
   * A host that has never drawn a frame may still be loading its document   a
   * shared overlay created with the first modal of a session, or a bounded
   * panel host whose renderer is still coming up. That load is not the dock's
   * failure, so the first projection gets the generous, bounded window below;
   * once the host has answered once it is proven and every later frame must
   * confirm promptly or the fallback is the right answer.
   */
  private confirmed = false
  private active = false
  constructor(
    private id: string,
    private interact: (report: NativeDockInteraction) => void,
    private measuredBounds: (width: number, height: number) => BrowserViewBounds,
    private passive = false,
    private modalOptions?: {
      onHover: (element: HTMLElement) => void
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
        this.confirmed = true
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
      if (!this.modalOptions.onKey?.(event)) {
        // Every key goes to the control the native document focused, Tab
        // included: the switcher cycles its entries on it, and a list that owns
        // Tab must see it. The key is delivered to the source's own element, so
        // its handlers run exactly as they would with that control focused here.
        const target = this.keyTarget(input.target) ?? this.root
        if (target) target.dispatchEvent(event)
        else window.dispatchEvent(event)
      }
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
      if (report.kind === 'focus') return
      if (report.kind === 'hover') {
        const action = this.actions.get(report.action)
        if (action && root.contains(action) && !action.matches(':disabled')) {
          action.dispatchEvent(new MouseEvent('mouseenter'))
          this.modalOptions?.onHover(action)
        }
        return
      }
      if (report.kind === 'scroll') {
        const target = this.scrollTargets.get(report.target)
        if (target && root.contains(target) && target.scrollTop !== report.top) {
          this.mirroredScrolls.set(target, report.top)
          target.scrollTop = report.top
        }
        return
      }
      if (report.kind !== 'click' && report.kind !== 'context') {
        this.interact(report)
        return
      }
      const target = this.actions.get(report.action)
      if (target && root.contains(target) && !target.matches(':disabled')) {
        const rect = target.getBoundingClientRect()
        const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
        const modifiers = {
          bubbles: true,
          cancelable: true,
          ctrlKey: report.control,
          shiftKey: report.shift,
          metaKey: report.meta,
          altKey: report.alt,
          ...point
        }
        if (report.kind === 'context') {
          target.dispatchEvent(new MouseEvent('contextmenu', { ...modifiers, button: 2 }))
          return
        }
        // A real press, not only its outcome: a control that selects on
        // pointerdown   a command row does   never saw the pointer at all when
        // just the click was dispatched.
        const press = {
          ...modifiers,
          button: 0,
          pointerId: 1,
          isPrimary: true,
          pointerType: 'mouse'
        }
        target.dispatchEvent(new PointerEvent('pointerdown', press))
        target.dispatchEvent(new PointerEvent('pointerup', press))
        target.dispatchEvent(new MouseEvent('click', { ...modifiers, button: 0 }))
        return
      }
      // A press the source can no longer resolve   the row left the list, or the
      // action map moved between the overlay's paint and the press   must still
      // come down. Swallowing it leaves a modal covering the window with no way
      // to close it.
      this.modalOptions?.onDismiss()
    })
    const scrolled = (event: Event): void => {
      const target = event.target
      if (target instanceof HTMLElement && this.mirroredScrolls.get(target) === target.scrollTop)
        return
      this.schedule()
    }
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
      this.focusables.clear()
      this.scrollTargets.clear()
      this.imageSources.clear()
      this.deliveredImages.clear()
      this.imageCopies.clear()
      this.imageCopyPending.clear()
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
    // A panel that was hidden left the native host, which drops the dock and the
    // image cache that came with it. Re-entering sends every image again rather
    // than believing the host still holds what it was sent before the hide.
    const resumed = !this.active
    this.active = true
    if (resumed) {
      this.deliveredImages.clear()
      // A hidden dock leaves its native host, so the one that answers next is
      // not necessarily the one that answered before. It starts unproven again.
      this.confirmed = false
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.frame || !this.active || !this.root) return
    this.frame = setTimeout(() => {
      this.frame = undefined
      this.publish()
    }, 16)
  }

  /** Resolve the native document's focused control to the element that owns it. */
  private keyTarget(target: string | null | undefined): HTMLElement | null {
    if (!target || target.length < 3) return null
    const id = target.slice(2)
    switch (target[0]) {
      case 'f':
        return this.fields.get(id) ?? null
      case 'a':
        return this.actions.get(id) ?? null
      case 'n':
        return this.focusables.get(id) ?? null
      default:
        return null
    }
  }
  /**
   * Whether the app hides this node with an inline style.
   *
   * Class-based hiding already travels: the class list is projected and the
   * native document loads the same stylesheet. Inline hiding does not, so it is
   * read from the element itself and the node is dropped rather than drawn.
   */
  private isHidden(node: HTMLElement): boolean {
    const style = node.style
    if (style.display === 'none' || style.visibility === 'hidden') return true
    if (style.overflow !== 'hidden') return false
    // The screen-reader idiom: a 1px box clipped out of the flow.
    if (style.position === 'absolute' || style.position === 'fixed') return style.clip !== ''
    return style.width === '1px' && style.height === '1px'
  }
  private nodeCount = 0
  /**
   * Whether this element is a scroll host the native document must mirror.
   *
   * The class check is the cheap path and covers the app's own convention. The
   * measured fallback catches a host styled by anything else, and only reads a
   * computed style when the element really holds more content than it shows, so
   * it costs that read for the few elements that could scroll rather than one
   * per projected node.
   */
  private isScrollHost(node: HTMLElement): boolean {
    if (node.matches('.overflow-auto, .overflow-y-auto, .overflow-scroll, .overflow-y-scroll'))
      return true
    if (node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1)
      return false
    const style = getComputedStyle(node)
    return (
      ['auto', 'scroll'].includes(style.overflowY) || ['auto', 'scroll'].includes(style.overflowX)
    )
  }
  private project(node: Node, depth = 0): NativeDockNode | string | null {
    if (++this.nodeCount > (this.modalOptions ? MAX_NATIVE_DOCK_NODES : 512) || depth > 24)
      throw new TypeError('Native dock tree is too large')
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (!(node instanceof Element) || !NATIVE_DOCK_TAGS.has(node.localName)) return null
    // Picker rows also mount their regular sidebar markup, hidden. It is not
    // part of the palette and must not spend its projection budget.
    if (this.modalOptions && node instanceof HTMLElement && node.classList.contains('hidden'))
      return null
    // A node the app hides with an inline style is hidden to the eye, and the
    // projection carries markup rather than the browser's layout: copying it
    // would draw it at full size. bits-ui hides an input's own label this way,
    // which is how a screen-reader heading ended up on screen in every dialog.
    if (
      this.modalOptions &&
      node instanceof HTMLElement &&
      node !== this.root &&
      this.isHidden(node)
    )
      return null
    const attributes: Record<string, string> = {}
    for (const attribute of node.attributes) {
      if (attribute.name === 'src' && attribute.value.startsWith('data:image/')) {
        const source = this.projectedImageSource(attribute.value)
        if (source === null) continue
        let id = this.imageSources.get(source)
        if (!id) {
          id = `image-${++this.imageCounter}`
          this.imageSources.set(source, id)
        }
        this.frameImages[id] = source
        attributes['data-native-dock-image'] = id
        continue
      }
      if (attribute.name !== 'style' && NATIVE_DOCK_ATTRIBUTES.has(attribute.name))
        attributes[attribute.name] = attribute.value
    }
    if (node instanceof HTMLElement || node instanceof SVGElement) {
      // One list, one colour form, one guard: what this builds is exactly what
      // `nativeDockStyleAllowed` accepts, so an inline style can never be
      // projected in a shape the validator then refuses.
      const sizing = NATIVE_DOCK_STYLE_PROPERTIES.map((property) => {
        const value = nativeDockColor(node.style.getPropertyValue(property))
        const declaration = `${property}: ${value};`
        return value && nativeDockStyleAllowed(declaration) ? declaration : ''
      })
        .filter(Boolean)
        .join(' ')
      // A wrapper that stays out of the box tree (`display: contents`) must say
      // so, or the projected panel lays out and scrolls differently from the
      // one the app window drew.
      const display =
        node instanceof HTMLElement && node.style.display
          ? `display: ${node.style.display.trim()};`
          : ''
      const style = [sizing, display]
        .filter((part) => part && nativeDockStyleAllowed(part))
        .join(' ')
      if (style.trim()) attributes.style = style.trim()
    }
    if (node instanceof SVGElement) {
      // Icons can paint solid strokes through inline CSS. Resolve only those
      // explicit paints, then carry safe colours as SVG attributes so stripping
      // inline styles cannot turn a plus into a minus.
      for (const property of ['fill', 'stroke'] as const) {
        if (!node.style.getPropertyValue(property)) continue
        const paint = nativeDockColor(getComputedStyle(node).getPropertyValue(property))
        if (paint && nativeDockStyleAllowed(`color: ${paint};`)) attributes[property] = paint
      }
    }
    if (this.modalOptions && node instanceof HTMLElement && this.isScrollHost(node)) {
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
    // A drag handle is not an action, so a press on it starts a drag. Everything
    // else inside one   the buttons on a dockable panel's header   keeps its own
    // press: the header is the handle, not the controls on it.
    if (
      node instanceof HTMLElement &&
      node.closest('[data-native-dock-handle]') !== node &&
      !node.matches(DOCK_GRAB_SELECTOR) &&
      node.matches(DOCK_ACTION_SELECTOR)
    ) {
      let action = this.buttons.get(node)
      if (!action) {
        action = `action-${++this.actionCounter}`
        this.buttons.set(node, action)
      }
      attributes['data-native-dock-action'] = action
      this.actions.set(action, node)
    }
    if (node instanceof HTMLElement && node.hasAttribute('aria-selected')) {
      // A row the list marks as current: hover and selection styling, and the
      // keyboard highlight, key off this instead of a tag name.
      attributes['data-native-dock-row'] = ''
    }
    if (
      node instanceof HTMLElement &&
      !(node instanceof HTMLButtonElement) &&
      !(node instanceof HTMLInputElement) &&
      !(node instanceof HTMLTextAreaElement) &&
      node.tabIndex >= 0
    ) {
      // A focusable element that is neither a button nor a field still owns
      // keyboard behaviour (a roving-tabindex list, a disclosure). It needs an
      // identity so the native document can name the control it focused.
      let id = this.focusKeys.get(node)
      if (!id) {
        id = `focus-${++this.actionCounter}`
        this.focusKeys.set(node, id)
      }
      this.focusables.set(id, node)
      attributes['data-native-dock-focus-key'] = id
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

  /**
   * The source the dock may carry for one icon, or null while it is being made.
   *
   * An icon inside the per-image budget is projected as it stands. A larger one
   * is replaced by a copy at the size it is drawn, decoded once and kept, and
   * this frame projects the node without an image: a panel that is missing one
   * glyph is the panel, while a panel refused over that glyph is the app window
   * with the browser hidden behind it.
   *
   * The frame also holds at most {@link MAX_NATIVE_DOCK_IMAGES} distinct icons.
   * A panel that references more is drawn with the surplus blank rather than
   * refused, so a tab strip that grows a hundred favicons can never take the
   * browser down with it.
   */
  private projectedImageSource(source: string): string | null {
    let resolved: string | null
    if (source.length <= MAX_NATIVE_DOCK_IMAGE_SOURCE_CHARS) {
      resolved = source
    } else if (this.imageCopyFailed.has(source)) {
      resolved = null
    } else {
      const copy = this.imageCopies.get(source)
      if (copy) resolved = copy
      else {
        this.enqueueImageCopy(source)
        resolved = null
      }
    }
    if (resolved === null) return null
    if (!this.frameImageSources.has(source)) {
      if (this.frameImageSources.size >= MAX_NATIVE_DOCK_IMAGES) return null
      this.frameImageSources.add(source)
    }
    return resolved
  }

  /** Decode one oversized icon and re-project the frame when its copy is ready. */
  private enqueueImageCopy(source: string): void {
    if (this.imageCopyPending.has(source)) return
    this.imageCopyPending.add(source)
    const image = new Image()
    image.onload = () => {
      this.imageCopyPending.delete(source)
      const copy = copyNativeDockImage(image)
      if (copy === null) {
        this.imageCopyFailed.add(source)
        return
      }
      this.imageCopies.set(source, copy)
      this.schedule()
    }
    image.onerror = () => {
      this.imageCopyPending.delete(source)
      this.imageCopyFailed.add(source)
    }
    image.src = source
  }

  private publish(): void {
    if (!this.root || !this.bounds || !this.active) return
    if (this.modalOptions?.requireCompleteProjection) {
      const refusal = nativeModalRefusal(this.root, { panel: this.modalOptions.panel === true })
      if (refusal) {
        // Content the projection cannot carry is a supported limitation, not a
        // failure: the app window is the designed fallback for it, so it is
        // logged at dev level. Only a broken projection is an error.
        this.refuse(`its content cannot be projected: ${refusal}`, true)
        return
      }
    }
    try {
      const rect = this.root.getBoundingClientRect()
      this.bounds = this.measuredBounds(rect.width, rect.height)
      this.actions.clear()
      this.fields.clear()
      this.focusables.clear()
      this.scrollTargets.clear()
      this.nodeCount = 0
      this.frameImages = {}
      this.frameImageSources.clear()
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
      this.timer = setTimeout(
        () => this.refuse('its host never confirmed the panel it was given'),
        this.ackDeadline()
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

  /**
   * How long this frame's host gets to confirm it drew, in milliseconds.
   *
   * A modal draws in the shared full-window overlay, which the session's first
   * gesture loads and keeps (`renderer/lib/overlay-host-warm.ts`), so two
   * seconds is enough for it to prove it drew. A bounded panel host is loaded
   * while the browser view is up, but a reveal can still land while that load is
   * in flight, and nothing is drawn in the app window while it waits: five
   * seconds bounds that wait without turning a slow start into a fallback. The
   * first projection to a host that has never answered is different again: its
   * document may still be loading, on a cold, busy boot that load is what the
   * user watches, and the same generous window the passive surfaces already use
   * bounds it without letting a host that never answers keep the panel forever.
   * Every later frame is held to the short deadline because a host that has
   * answered once has proven it can.
   */
  private ackDeadline(): number {
    if (this.passive || !this.confirmed) return OVERLAY_ACK_TIMEOUT_MS
    return this.modalOptions?.panel ? 5000 : 2000
  }

  private typography(): NonNullable<import('$shared/native-dock').NativeDockRequest['typography']> {
    const style = getComputedStyle(document.documentElement)
    return {
      fontFamily: style.getPropertyValue('--font-app').trim(),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseFloat(style.fontWeight)
    }
  }

  private refuse(reason?: string, supported = false): void {
    this.failed = true
    if (reason) {
      const message = `The native dock '${this.id}' fell back to the app window: ${reason}`
      if (supported) logRendererDev(message)
      else logRendererError(message)
    }
    this.modalOptions?.onFailure?.(reason)
    this.ready = false
    this.active = false
    clearTimeout(this.timer)
    void invoke('browser:setDockOverlay', this.id, null).catch(() => {})
  }
}
