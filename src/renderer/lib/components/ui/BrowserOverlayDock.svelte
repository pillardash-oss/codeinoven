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
  import { onMount } from 'svelte'
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
  let lastScroll: { target: string; top: number } | null = null
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
      target.scrollTop = Number(target.dataset.nativeDockScrollTop ?? 0)
    }
    if (current.modal) {
      for (const row of element.querySelectorAll<HTMLElement>('button[aria-selected]')) {
        row.dataset.nativeModalRow = ''
      }
      highlight(element, hoveredAction ?? selectedAction)
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
    element.addEventListener('contextmenu', contextmenu)
    element.addEventListener('keydown', keydown)
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', up)
    element.addEventListener('scroll', scroll, true)
    if (dock.modal) {
      void invoke('browser:overlayCursor')
        .then((point) => {
          pointerOrigin ??= point
        })
        .catch(() => {})
    }
    return () => {
      element.removeEventListener('click', click)
      element.removeEventListener('contextmenu', contextmenu)
      element.removeEventListener('keydown', keydown)
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', up)
      element.removeEventListener('scroll', scroll, true)
      cancelAnimationFrame(frame)
      if (origin) onDragging(false)
    }
  }
  function highlight(element: HTMLElement, action: string | null): void {
    for (const row of element.querySelectorAll<HTMLElement>('button[aria-selected]')) {
      row.setAttribute('aria-selected', String(row.dataset.nativeDockAction === action))
    }
  }
  function scroll(event: Event): void {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.dataset.nativeDockScroll) return
    const id = target.dataset.nativeDockScroll
    if (lastScroll?.target === id && lastScroll.top === target.scrollTop) return
    lastScroll = { target: id, top: target.scrollTop }
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
    const button = target.closest<HTMLButtonElement>('button[data-native-dock-action]')
    const action = button?.getAttribute('data-native-dock-action')
    const key = button?.dataset.nativeDockKey
    if (dock.modal && key && !button.disabled) {
      report({ id: dock.id, kind: 'commit', key })
      return
    }
    if (action && !button?.disabled) report({ id: dock.id, kind: 'click', action })
  }
  function contextmenu(event: MouseEvent): void {
    // macOS turns a left press with Control held into a context menu instead
    // of a click. Ctrl+Tab users are still holding that modifier when picking.
    if (!dock.modal || !event.ctrlKey || event.button !== 0) return
    event.preventDefault()
    if (event.target instanceof Element && event.target.closest('[data-native-modal-backdrop]'))
      report({ id: dock.id, kind: 'dismiss' })
    else click(event)
  }
  function keydown(event: KeyboardEvent): void {
    if (dock.modal) {
      event.preventDefault()
      return
    }
    if (!(event.target instanceof Element) || !event.target.closest('[data-native-dock-handle]'))
      return
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    report({ id: dock.id, kind: 'edge', key: event.key })
  }
  function down(event: PointerEvent): void {
    if (
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.target.closest('[data-native-dock-handle]')
    )
      return
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
      const row = event.target.closest<HTMLButtonElement>(
        'button[aria-selected][data-native-dock-action]'
      )
      const action = row?.dataset.nativeDockAction
      if (action && !row.disabled && pointerMoved) {
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
      class="absolute inset-0 h-full w-full cursor-default bg-overlay/70"
      aria-label="Dismiss switcher"
      title="Dismiss switcher"
      onclick={() => report({ id: dock.id, kind: 'dismiss' })}
    ></button>
  {/if}
  <div
    class={dock.modal ? 'absolute flex flex-col' : 'flex min-w-0 items-stretch gap-1.5'}
    style:left={dock.modal ? `${dock.bounds.x}px` : undefined}
    style:top={dock.modal ? `${dock.bounds.y}px` : undefined}
    style:width={dock.modal ? `${dock.bounds.width}px` : undefined}
    style:height={dock.modal ? `${dock.bounds.height}px` : undefined}
    {@attach draw}
  ></div>
</div>

<style>
  :global([data-native-modal-row]),
  :global([data-native-modal-row] *) {
    cursor: pointer;
  }
  :global([data-native-modal-row]:hover) {
    background: var(--color-elevated);
  }
  :global([data-native-modal-row][aria-selected='true']) {
    background: var(--color-selected);
  }
  :global([data-native-modal-row] > .bg-selected) {
    background: transparent;
  }
</style>
