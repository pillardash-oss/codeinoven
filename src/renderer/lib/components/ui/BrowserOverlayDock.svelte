<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import {
    nativeDockImageIds,
    type NativeDockNode,
    type NativeDockRequest,
    type NativeDockInteraction
  } from '$shared/native-dock'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { patchNativeDockChildren } from '$lib/native-dock-dom'
  import { findPanelPrimaryAction } from '$lib/modal-primary-action.svelte'
  import { onMount, tick } from 'svelte'
  import { fly, fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  let { dock, onDragging }: { dock: NativeDockRequest; onDragging: (dragging: boolean) => void } =
    $props()
  let origin: { x: number; y: number } | null = null
  let pending: NativeDockInteraction | null = null
  let frame = 0
  let pointerOrigin: { x: number; y: number } | null = null
  let pointerMoved = false
  let hoveredAction: string | null = null
  let hoveredAt = 0
  let selectedAction: string | null = null
  let modalRoot: HTMLDivElement | null = null
  /**
   * The position this document last reported for each scroll host.
   *
   * The app mirrors what this document reports, so its next projection carries
   * the position sent a round trip ago as `data-native-dock-scroll-top`.
   * Writing that back drags a live gesture backwards every time a frame lands,
   * which reads as a list that shakes and crawls instead of scrolling. A
   * projected position this document never reported is the app moving the
   * container itself   a search result scrolled into view, a list reset to the
   * top   and that one is applied.
   *
   * Keyed by the host element rather than the identity the projection gives it,
   * so a replaced host can never be answered for with a dead position. It is also
   * deliberately not reactive: bookkeeping the draw attachment reads may not
   * schedule the draw again, or every scroll would re-patch the whole panel.
   */
  const reportedScrollTops = new WeakMap<HTMLElement, number>()
  let images: Record<string, string> = {}
  function report(report: NativeDockInteraction): void {
    void invoke('browser:overlayDockInteract', report).catch(() => {})
  }
  function create(node: NativeDockNode | string, svg = false): Node {
    if (typeof node === 'string') return document.createTextNode(node)
    const inSvg = svg || node.tag === 'svg'
    const element = inSvg
      ? document.createElementNS('http://www.w3.org/2000/svg', node.tag)
      : document.createElement(node.tag)
    for (const [name, value] of Object.entries(node.attributes)) element.setAttribute(name, value)
    const imageId = node.attributes['data-native-dock-image']
    if (imageId && images[imageId]) element.setAttribute('src', images[imageId])
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      element.value = node.attributes['data-native-dock-value'] ?? ''
    for (const child of node.children) element.appendChild(create(child, inSvg))
    return element
  }
  const draw: Attachment<HTMLDivElement> = (element) => {
    modalRoot = element
    const current = dock
    const nextImages: Record<string, string> = {}
    for (const id of nativeDockImageIds(current.nodes)) {
      const source = current.images?.[id] ?? images[id]
      if (source) nextImages[id] = source
    }
    images = nextImages
    if (selectedAction !== (current.selectedAction ?? null)) {
      if (hoveredAction !== current.selectedAction) hoveredAction = null
      selectedAction = current.selectedAction ?? null
    }
    patchNativeDockChildren(
      element,
      current.nodes.map((node) => create(node))
    )
    for (const target of element.querySelectorAll<HTMLElement>('[data-native-dock-scroll]')) {
      const top = Number(target.dataset.nativeDockScrollTop ?? 0)
      if (reportedScrollTops.get(target) === top) continue
      if (target.scrollTop !== top) target.scrollTop = top
    }
    if (current.panel) {
      const field = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '[data-native-dock-focus]'
      )
      if (field && document.activeElement !== field) field.focus({ preventScroll: true })
    }
    if (current.modal) {
      highlight(element, hoveredAction ?? selectedAction)
      focusPanel(element)
    }
    void invoke('browser:overlayDockDrawn', {
      id: current.id,
      revision: current.revision
    }).catch(() => {})
    return () => {
      modalRoot = null
    }
  }
  const events: Attachment<HTMLDivElement> = (element) => {
    element.addEventListener('click', click)
    element.addEventListener('input', input)
    element.addEventListener('keyup', fieldKey)
    element.addEventListener('contextmenu', contextmenu)
    element.addEventListener('keydown', keydown)
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', up)
    element.addEventListener('scroll', scroll, true)
    element.addEventListener('focusin', focusChanged)
    element.addEventListener('focusout', focusChanged)
    if (dock.modal) {
      void invoke('browser:overlayCursor')
        .then((point) => {
          pointerOrigin ??= point
        })
        .catch(() => {})
    }
    return () => {
      element.removeEventListener('click', click)
      element.removeEventListener('input', input)
      element.removeEventListener('keyup', fieldKey)
      element.removeEventListener('contextmenu', contextmenu)
      element.removeEventListener('keydown', keydown)
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', up)
      element.removeEventListener('scroll', scroll, true)
      element.removeEventListener('focusin', focusChanged)
      element.removeEventListener('focusout', focusChanged)
      cancelAnimationFrame(frame)
      if (origin) onDragging(false)
    }
  }
  function highlight(element: HTMLElement, action: string | null): void {
    for (const row of element.querySelectorAll<HTMLElement>('[data-native-dock-row]')) {
      if (!row.dataset.nativeDockAction) continue
      row.setAttribute('aria-selected', String(row.dataset.nativeDockAction === action))
    }
  }
  /**
   * Focus the panel's own first control in the native document.
   *
   * Without a focused control here the panel accepts no typing at all   the
   * caret has nowhere to go   and every key only reaches the source after the
   * user has tabbed into the dialog by hand. The window itself is already the
   * key window, so a panel with no control at all still receives its shortcuts.
   */
  function focusPanel(element: HTMLElement): void {
    // Only an identified control counts as the focused one. The viewport root
    // and the document body are reachable through the panel but answer nothing,
    // and treating them as "already focused" is what left a redrawn panel with
    // no caret and a dead keyboard.
    const active = document.activeElement
    if (
      active instanceof Element &&
      element.contains(active) &&
      active.closest(
        '[data-native-dock-field], [data-native-dock-action], [data-native-dock-focus-key]'
      )
    )
      return
    const field = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '[data-native-dock-focus], input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])'
    )
    const target =
      field ??
      findPanelPrimaryAction(element) ??
      element.querySelector<HTMLElement>('[data-native-dock-action]:not([disabled])')
    if (!target) return
    target.focus({ preventScroll: true })
    if (field?.hasAttribute('data-native-dock-select')) field.select()
  }
  /**
   * Tell the app which control owns the keyboard, so a forwarded key can be
   * delivered to the element that answers for it.
   */
  function focusChanged(): void {
    void tick().then(() => {
      const active = document.activeElement
      const control =
        active instanceof Element
          ? active.closest<HTMLElement>(
              '[data-native-dock-field], [data-native-dock-action], [data-native-dock-focus-key]'
            )
          : null
      const field = control?.dataset.nativeDockField
      const action = control?.dataset.nativeDockAction
      const focus = control?.dataset.nativeDockFocusKey
      const target = field ? `f:${field}` : action ? `a:${action}` : focus ? `n:${focus}` : null
      report({ id: dock.id, kind: 'focus', target })
    })
  }
  function scroll(event: Event): void {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.dataset.nativeDockScroll) return
    const id = target.dataset.nativeDockScroll
    if (reportedScrollTops.get(target) === target.scrollTop) return
    reportedScrollTops.set(target, target.scrollTop)
    report({ id: dock.id, kind: 'scroll', target: id, top: target.scrollTop })
  }
  onMount(() =>
    subscribe('browser:overlay:dockCommit', (request) => {
      if (request.id !== dock.id || !dock.modal) return
      // Keyboard cycling may still be waiting for its batched paint. Compare
      // event times rather than committing an older projected selection.
      const hoveredRow = [
        ...(modalRoot?.querySelectorAll<HTMLElement>('[data-native-modal-row]') ?? [])
      ].find((row) => row.dataset.nativeDockAction === hoveredAction)
      const key =
        hoveredAction && hoveredAt > request.keyboardAt
          ? hoveredRow?.dataset.nativeDockKey
          : request.selectedKey
      if (key) report({ id: dock.id, kind: 'commit', key })
      else report({ id: dock.id, kind: 'dismiss' })
    })
  )
  function click(event: MouseEvent): void {
    const target = event.target
    if (!(target instanceof Element)) return
    const control = target.closest<HTMLElement>('[data-native-dock-action]')
    const action = control?.getAttribute('data-native-dock-action')
    const disabled = isDisabled(control)
    if (dock.modal && control?.dataset.nativeDockKey && !disabled) {
      report({ id: dock.id, kind: 'commit', key: control.dataset.nativeDockKey })
      return
    }
    if (action && !disabled)
      report({
        id: dock.id,
        kind: 'click',
        action,
        control: event.ctrlKey,
        shift: event.shiftKey,
        meta: event.metaKey,
        alt: event.altKey
      })
  }
  /** A disabled control looks the same whatever tag it is. */
  function isDisabled(control: HTMLElement | null | undefined): boolean {
    return Boolean(
      control && (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true')
    )
  }
  function contextmenu(event: MouseEvent): void {
    // macOS turns a left press with Control held into a context menu instead
    // of a click. Ctrl+Tab users are still holding that modifier when picking.
    if (dock.panel && event.target instanceof Element) {
      const control = event.target.closest<HTMLElement>('[data-native-dock-action]')
      const action = control?.dataset.nativeDockAction
      if (action && !isDisabled(control)) {
        event.preventDefault()
        report({ id: dock.id, kind: 'context', action })
      }
      return
    }
    if (!dock.modal || !event.ctrlKey || event.button !== 0) return
    event.preventDefault()
    if (event.target instanceof Element && event.target.closest('[data-native-modal-backdrop]'))
      report({ id: dock.id, kind: 'dismiss' })
    else click(event)
  }
  function input(event: Event): void {
    const field = event.target
    if (
      !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
      !field.dataset.nativeDockField
    )
      return
    const version = Number(field.dataset.nativeDockVersion ?? 0) + 1
    field.dataset.nativeDockVersion = String(version)
    field.dataset.nativeDockValue = field.value
    report({
      id: dock.id,
      kind: 'field',
      field: field.dataset.nativeDockField,
      value: field.value,
      version
    })
  }
  function fieldKey(event: KeyboardEvent): boolean {
    const field = event.target
    if (
      !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
      !field.dataset.nativeDockField
    )
      return false
    if (event.ctrlKey || event.metaKey) return true
    // The key itself is forwarded to the source by the window that owns the
    // keyboard. This only decides the native document's own default: a
    // single-line field submits on Enter instead of inserting a newline, and a
    // field may claim keys through `data-native-dock-keys`.
    if (
      event.type === 'keydown' &&
      ((event.key === 'Enter' && field instanceof HTMLInputElement) ||
        field.dataset.nativeDockKeys?.split(' ').includes(event.key))
    )
      event.preventDefault()
    return true
  }
  /** The panel's own focus order, for wrapping Tab at its edges. */
  function focusOrder(root: HTMLElement): HTMLElement[] {
    const selector = [
      '[data-native-dock-action]:not([disabled]):not([tabindex="-1"])',
      '[data-native-dock-field]:not([disabled])',
      '[data-native-dock-focus-key]:not([tabindex="-1"])',
      'button:not([disabled]):not([tabindex="-1"])',
      'input:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ')
    return [...new Set(root.querySelectorAll<HTMLElement>(selector))]
  }
  function keydown(event: KeyboardEvent): void {
    if (!dock.modal) {
      if (fieldKey(event)) return
      if (!(event.target instanceof Element) || !event.target.closest('[data-native-dock-handle]'))
        return
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      report({ id: dock.id, kind: 'edge', key: event.key })
      return
    }
    // The source answers every key (the window that owns the keyboard forwards
    // it, and the controller delivers it to the control this document focused),
    // so only the native document's own defaults are settled here: Escape and
    // Cmd+Enter belong to the source, a control activates on Enter and Space,
    // and Tab walks the panel and wraps at its own edges.
    // The switcher source owns Tab cycling. Native traversal would scroll a
    // different row into view before the projected highlight arrives.
    if (event.key === 'Tab' && dock.id === 'thread-switcher') {
      event.preventDefault()
      return
    }
    if (event.key === 'Tab' && modalRoot) {
      const controls = focusOrder(modalRoot)
      const next = event.shiftKey ? controls.at(-1) : controls[0]
      const edge = event.shiftKey ? controls[0] : controls.at(-1)
      if (document.activeElement === edge && next) {
        event.preventDefault()
        next.focus()
      }
      return
    }
    if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
      event.preventDefault()
      return
    }
    if (fieldKey(event)) return
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element) {
      const control = event.target.closest<HTMLElement>('[data-native-dock-action]')
      if (control && !isDisabled(control)) {
        event.preventDefault()
        if (!event.repeat) control.click()
      }
    }
  }
  function down(event: PointerEvent): void {
    if (event.button !== 0 || !(event.target instanceof Element)) return
    const handle = event.target.closest('[data-native-dock-handle]')
    if (!handle) return
    // The whole handle drags   a dockable panel's header, a dock chip's grip
    // but not the controls on it. A press that lands on one of those is that
    // control's press, which is exactly how the app window treats a header's own
    // buttons.
    const control = event.target.closest('[data-native-dock-action]')
    if (control && control !== handle) return
    origin = { x: event.clientX, y: event.clientY }
    onDragging(true)
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function move(event: PointerEvent): void {
    if (dock.modal && event.target instanceof Element) {
      pointerOrigin ??= { x: event.clientX, y: event.clientY }
      const dx = event.clientX - pointerOrigin.x
      const dy = event.clientY - pointerOrigin.y
      if (dx * dx + dy * dy > 16) pointerMoved = true
      const row = event.target.closest<HTMLElement>('[data-native-dock-action]')
      const action = row?.dataset.nativeDockAction
      if (action && !isDisabled(row) && pointerMoved) {
        hoveredAt = performance.timeOrigin + performance.now()
        if (action !== hoveredAction) {
          hoveredAction = action
          if (modalRoot) highlight(modalRoot, action)
          report({ id: dock.id, kind: 'hover', action })
        }
      }
    }
    if (!origin) return
    pending = {
      id: dock.id,
      kind: 'drag',
      dx: event.clientX - origin.x,
      dy: event.clientY - origin.y,
      done: false
    }
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pending) report(pending)
        pending = null
      })
  }
  function up(event: PointerEvent): void {
    if (!origin) return
    cancelAnimationFrame(frame)
    frame = 0
    pending = null
    report({
      id: dock.id,
      kind: 'drag',
      dx: event.clientX - origin.x,
      dy: event.clientY - origin.y,
      done: true
    })
    origin = null
    onDragging(false)
    if (
      event.currentTarget instanceof HTMLElement &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    )
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
</script>

<div
  role="group"
  data-native-overlay-dock
  data-native-overlay-passive={dock.passive || undefined}
  class={[
    dock.modal ? 'fixed inset-0 z-80' : 'fixed z-50 flex items-stretch gap-1.5',
    dock.passive && 'pointer-events-none'
  ]}
  style:left={dock.modal ? undefined : `${dock.bounds.x}px`}
  style:top={dock.modal ? undefined : `${dock.bounds.y}px`}
  {@attach events}
>
  {#if dock.modal}
    <button
      type="button"
      tabindex={-1}
      data-native-modal-backdrop
      transition:fade|global={{ duration: prefersReducedMotion.current ? 0 : 140 }}
      class="absolute inset-0 h-full w-full cursor-default bg-overlay/70"
      aria-label="Dismiss dialog"
      title="Dismiss dialog"
      onclick={() => report({ id: dock.id, kind: 'dismiss' })}
    ></button>
  {/if}
  <div
    class={dock.modal ? 'absolute flex flex-col' : 'flex min-w-0 items-stretch gap-1.5'}
    style:left={dock.modal ? `${dock.bounds.x}px` : undefined}
    style:top={dock.modal ? `${dock.bounds.y}px` : undefined}
    style:width={dock.modal ? `${dock.bounds.width}px` : undefined}
    style:height={dock.modal ? `${dock.bounds.height}px` : undefined}
    data-native-modal-panel={dock.modal || undefined}
    transition:fly|global={{
      duration: dock.modal && !prefersReducedMotion.current ? 140 : 0,
      y: 4
    }}
    {@attach draw}
  ></div>
</div>

<style>
  /* Every control the projection identified, whatever tag it is: a command row
     is a div, and the app's own cursor rule cannot reach into this document's
     class list the way it reaches its own. */
  :global([data-native-overlay-dock] [data-native-dock-action]:not([disabled])) {
    cursor: pointer;
  }
  :global([data-native-overlay-dock] [data-native-dock-action][aria-disabled='true']) {
    cursor: default;
  }
  :global([data-native-dock-row]),
  :global([data-native-dock-row] *) {
    cursor: pointer;
  }
  :global([data-native-dock-row]:hover) {
    background: var(--color-elevated);
  }
  :global([data-native-dock-row][aria-selected='true']) {
    background: var(--color-selected);
  }
  :global([data-native-dock-row] > .bg-selected) {
    background: transparent;
  }
</style>
