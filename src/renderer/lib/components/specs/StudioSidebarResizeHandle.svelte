<script lang="ts">
  import { onMount } from 'svelte'
  import { APP_SLUG } from '$shared/brand'

  interface Props {
    sidebarLabel: string
    axis?: 'x' | 'y'
    value?: number
    min?: number
    max?: number
    onResize?: (value: number) => void
    onCommit?: () => void
    class?: string
  }

  let {
    sidebarLabel,
    axis = 'x',
    value,
    min = 0,
    max = 10000,
    onResize,
    onCommit,
    class: className
  }: Props = $props()
  let handle: HTMLButtonElement | null = null
  let resizing = false
  let pointerId = 0
  let startX = 0
  let startWidth = 0

  const STORAGE_KEY = `${APP_SLUG}:studio-sidebar-width`
  const DEFAULT_WIDTH = 208
  const MIN_WIDTH = 176
  const MAX_WIDTH = 420

  function layout(): { sidebar: HTMLElement; grid: HTMLElement } | null {
    const sidebar = handle?.closest<HTMLElement>('aside')
    const grid = sidebar?.parentElement
    return sidebar && grid ? { sidebar, grid } : null
  }

  function clampWidth(width: number): number {
    const viewportMaximum = Math.max(MIN_WIDTH, window.innerWidth - 480)
    return Math.min(Math.max(width, MIN_WIDTH), Math.min(MAX_WIDTH, viewportMaximum))
  }

  function applyWidth(width: number, persist = false): void {
    const elements = layout()
    if (!elements) return
    const next = clampWidth(width)
    elements.grid.style.gridTemplateColumns = `${next}px minmax(0, 1fr)`
    if (persist) localStorage.setItem(STORAGE_KEY, String(next))
  }

  function startResize(event: PointerEvent & { currentTarget: HTMLButtonElement }): void {
    if (onResize && value !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      resizing = true
      pointerId = event.pointerId
      startX = axis === 'x' ? event.clientX : event.clientY
      startWidth = value
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const elements = layout()
    if (!elements) return
    resizing = true
    pointerId = event.pointerId
    startX = event.clientX
    startWidth = elements.sidebar.getBoundingClientRect().width
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== pointerId) return
    if (onResize) {
      onResize(
        Math.min(
          max,
          Math.max(min, startWidth + (axis === 'x' ? event.clientX : event.clientY) - startX)
        )
      )
      return
    }
    applyWidth(startWidth + event.clientX - startX)
  }

  function finishResize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== pointerId) return
    resizing = false
    const target = event.currentTarget as HTMLButtonElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
    if (onResize) {
      onCommit?.()
      return
    }
    const width = layout()?.sidebar.getBoundingClientRect().width
    if (width !== undefined) applyWidth(width, true)
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (onResize && value !== undefined) {
      const delta =
        axis === 'x'
          ? event.key === 'ArrowLeft'
            ? -16
            : event.key === 'ArrowRight'
              ? 16
              : 0
          : event.key === 'ArrowUp'
            ? -16
            : event.key === 'ArrowDown'
              ? 16
              : 0
      if (!delta) return
      event.preventDefault()
      onResize(Math.min(max, Math.max(min, value + delta)))
      onCommit?.()
      return
    }
    const delta = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (!delta) return
    event.preventDefault()
    const width = layout()?.sidebar.getBoundingClientRect().width ?? DEFAULT_WIDTH
    applyWidth(width + delta, true)
  }

  onMount(() => {
    if (onResize) return
    const stored = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10)
    applyWidth(Number.isFinite(stored) ? stored : DEFAULT_WIDTH)
  })
</script>

<button
  {@attach (element) => {
    handle = element
    return () => {
      if (handle === element) handle = null
    }
  }}
  type="button"
  class={className ??
    'absolute inset-y-0 right-0 z-20 w-1.5 translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors max-md:hidden hover:bg-primary/30 focus:bg-primary/30 focus:outline-none'}
  title={`Resize ${sidebarLabel}`}
  aria-label={`Resize ${sidebarLabel}`}
  onpointerdown={startResize}
  onpointermove={resize}
  onpointerup={finishResize}
  onpointercancel={finishResize}
  onkeydown={resizeWithKeyboard}
></button>
