<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import type {
    NativeDockNode,
    NativeDockRequest,
    NativeDockInteraction
  } from '$shared/native-dock'
  import { TOAST_OVERLAY_TOP } from '$shared/browser-overlay'
  import { invoke } from '$lib/ipc.svelte'
  let { dock, onDragging }: { dock: NativeDockRequest; onDragging: (dragging: boolean) => void } =
    $props()
  let origin: { x: number; y: number } | null = null
  let pending: NativeDockInteraction | null = null
  let frame = 0
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
    for (const child of node.children) element.appendChild(create(child, inSvg))
    return element
  }
  const draw: Attachment<HTMLDivElement> = (element) => {
    $effect(() => {
      const current = dock
      element.replaceChildren(...current.nodes.map((node) => create(node)))
      void invoke('browser:overlayDockDrawn', {
        id: current.id,
        revision: current.revision
      }).catch(() => {})
    })
  }
  const events: Attachment<HTMLDivElement> = (element) => {
    element.addEventListener('click', click)
    element.addEventListener('keydown', keydown)
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', up)
    return () => {
      element.removeEventListener('click', click)
      element.removeEventListener('keydown', keydown)
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', up)
      cancelAnimationFrame(frame)
      if (origin) onDragging(false)
    }
  }
  function click(event: MouseEvent): void {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('button[data-native-dock-action]')
    const action = button?.getAttribute('data-native-dock-action')
    if (action && !button?.disabled) report({ id: dock.id, kind: 'click', action })
  }
  function keydown(event: KeyboardEvent): void {
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
  class={['fixed z-50 flex items-stretch gap-1.5', dock.passive && 'pointer-events-none']}
  style:left={`${dock.bounds.x}px`}
  style:top={`${dock.bounds.y - TOAST_OVERLAY_TOP}px`}
  {@attach events}
>
  <div class="flex min-w-0 items-stretch gap-1.5" {@attach draw}></div>
</div>
