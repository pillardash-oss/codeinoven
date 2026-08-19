<script lang="ts">
  import { Minus, X, GripVertical } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import { APP_SLUG } from '$shared/brand'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'

  interface Props {
    open: boolean
    title: string
    /** Whether the panel is collapsed into the bottom-right dock. */
    minimized: boolean
    /**
     * Whether the close (X) affordance is available. When false the header shows
     * only the minimize button, Escape minimizes, and there is no backdrop to
     * dismiss — the panel floats and the app stays usable behind it.
     */
    closable: boolean
    onMinimize: () => void
    onClose: () => void
    /** Restore the panel from the dock. */
    onExpand: () => void
    /** Content rendered inside the bottom-right dock while minimized. */
    dock: Snippet
    children: Snippet
    footer?: Snippet
    /** LocalStorage key used to persist the panel's position/size. */
    storageKey?: string
    /** Initial panel height before viewport clamping. */
    defaultHeight?: number
    /** Tooltip/aria label shown on the draggable header. */
    dragLabel?: string
  }

  let {
    open,
    title,
    minimized,
    closable,
    onMinimize,
    onClose,
    onExpand,
    dock,
    children,
    footer,
    storageKey = `${APP_SLUG}.harnessTasksPanel.v1`,
    defaultHeight = 560,
    dragLabel = 'Drag to move the task panel'
  }: Props = $props()

  const PANEL_MARGIN = 12
  const MIN_PANEL_WIDTH = 360
  const MAX_PANEL_WIDTH = 640
  const MIN_PANEL_HEIGHT = 240
  /** The chat composer's `max-w-2xl` — the panel must never cover it by default. */
  const CHAT_MAX_WIDTH = 672

  interface PanelSnapshot {
    x: number
    y: number
    width: number
    height: number
  }

  function availableWidth(): number {
    const sidebar = sidebarState.docked ? sidebarState.width : 0
    return Math.max(0, window.innerWidth - sidebar - PANEL_MARGIN * 2)
  }

  function availableHeight(): number {
    return Math.max(MIN_PANEL_HEIGHT, window.innerHeight - PANEL_MARGIN * 2)
  }

  function preferredHeight(): number {
    return Math.max(MIN_PANEL_HEIGHT, defaultHeight)
  }

  /**
   * The gap between the right edge of the chat composer and the right edge of
   * the window (with the left sidebar docked) — the panel's default max width so
   * it never covers the chat by default.
   */
  function preferredWidth(): number {
    return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, availableWidth() - CHAT_MAX_WIDTH))
  }

  function clampX(x: number, w: number): number {
    return Math.min(
      Math.max(PANEL_MARGIN, x),
      Math.max(PANEL_MARGIN, window.innerWidth - w - PANEL_MARGIN)
    )
  }

  function clampY(y: number, h: number): number {
    return Math.min(
      Math.max(PANEL_MARGIN, y),
      Math.max(PANEL_MARGIN, window.innerHeight - h - PANEL_MARGIN)
    )
  }

  function loadSnapshot(): PanelSnapshot | null {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<PanelSnapshot>
      if (
        typeof parsed.x !== 'number' ||
        typeof parsed.y !== 'number' ||
        typeof parsed.width !== 'number' ||
        typeof parsed.height !== 'number'
      ) {
        return null
      }
      return parsed as PanelSnapshot
    } catch {
      return null
    }
  }

  function persistSnapshot(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ x: position.x, y: position.y, width, height })
      )
    } catch {
      // Panel placement is cosmetic; unavailable storage must not break the app.
    }
  }

  const saved = loadSnapshot()
  const initialWidth = saved
    ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.min(saved.width, availableWidth())))
    : preferredWidth()
  const initialHeight = Math.min(
    availableHeight(),
    saved ? Math.max(MIN_PANEL_HEIGHT, saved.height) : preferredHeight()
  )

  let width = $state(initialWidth)
  let height = $state(initialHeight)
  let position = $state({
    x: saved
      ? clampX(saved.x, initialWidth)
      : Math.max(PANEL_MARGIN, window.innerWidth - initialWidth - PANEL_MARGIN),
    y: saved ? clampY(saved.y, initialHeight) : PANEL_MARGIN * 2
  })

  let dragging = $state(false)
  let dragStart = $state({ x: 0, y: 0 })
  let dragOrigin = $state({ x: 0, y: 0 })

  /** Keep the panel inside the viewport when the window resizes. */
  $effect(() => {
    if (!open) return
    const onResize = (): void => {
      width = Math.min(width, availableWidth())
      height = Math.min(height, availableHeight())
      position = { x: clampX(position.x, width), y: clampY(position.y, height) }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  function onHeaderPointerDown(event: PointerEvent): void {
    if (minimized || event.button !== 0) return
    // Let the header's own buttons keep their click behavior — never start a drag.
    if (event.target instanceof Element && event.target.closest('button')) return
    dragging = true
    dragStart = { x: event.clientX, y: event.clientY }
    dragOrigin = { x: position.x, y: position.y }
    const target = event.currentTarget
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onHeaderPointerMove(event: PointerEvent): void {
    if (!dragging) return
    position = {
      x: clampX(dragOrigin.x + (event.clientX - dragStart.x), width),
      y: clampY(dragOrigin.y + (event.clientY - dragStart.y), height)
    }
  }

  function onHeaderPointerUp(event: PointerEvent): void {
    if (!dragging) return
    dragging = false
    const target = event.currentTarget
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId)
    }
    persistSnapshot()
  }

  // Let the Cmd/Ctrl+W "close the active surface" shortcut mirror the Escape
  // behavior: expand a minimized panel, close a closable one, otherwise minimize.
  $effect(() => {
    if (!open) return
    return registerOverlayClose(() => {
      if (minimized) {
        onExpand()
      } else if (closable) {
        onClose()
      } else {
        onMinimize()
      }
    })
  })
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    if (!open || e.key !== 'Escape') return
    if (minimized) {
      onExpand()
    } else if (closable) {
      onClose()
    } else {
      onMinimize()
    }
  }}
/>

{#if open}
  <!--
    The panel stays mounted in the SAME tree position whether minimized or not so
    its embedded terminal PTYs are never torn down — minimize only hides it while
    the bottom-right dock keeps the run badges live. The dock renders as a sibling.
  -->
  <div
    class="fixed z-50 flex flex-col overflow-hidden rounded-2xl border bg-surface shadow-xl {minimized
      ? 'invisible pointer-events-none'
      : ''}"
    style="left: {position.x}px; top: {position.y}px; width: {width}px; height: {height}px;"
    role="dialog"
    aria-label={title}
  >
    <div
      class="flex shrink-0 cursor-grab items-center justify-between gap-3 border-b px-4 py-2.5 select-none {dragging
        ? 'cursor-grabbing'
        : ''}"
      title={dragLabel}
      aria-label={dragLabel}
      role="group"
      onpointerdown={onHeaderPointerDown}
      onpointermove={onHeaderPointerMove}
      onpointerup={onHeaderPointerUp}
    >
      <span class="flex min-w-0 items-center gap-2">
        <GripVertical size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        <h2 class="truncate text-xs font-semibold">{title}</h2>
      </span>
      <span class="flex shrink-0 items-center gap-1">
        <button
          class="flex h-6 w-6 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Minimize"
          title="Minimize"
          onclick={onMinimize}
        >
          <Minus size={14} />
        </button>
        {#if closable}
          <button
            class="flex h-6 w-6 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close"
            title="Close"
            onclick={onClose}
          >
            <X size={14} />
          </button>
        {/if}
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">{@render children()}</div>

    {#if footer}
      <div class="flex shrink-0 items-center justify-end gap-2 border-t bg-surface px-4 py-3">
        {@render footer()}
      </div>
    {/if}
  </div>

  {#if minimized}
    <div class="fixed right-4 bottom-4 z-50">{@render dock()}</div>
  {/if}
{/if}
