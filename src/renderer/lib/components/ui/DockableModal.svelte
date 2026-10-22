<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioGrip from '@pdslng/cio-icon/CioGrip.svelte'
  import CioMinus from '@pdslng/cio-icon/CioMinus.svelte'
  import type { Attachment } from 'svelte/attachments'
  import type { Snippet } from 'svelte'
  import { BitsConfig } from 'bits-ui'
  import { APP_SLUG } from '$shared/brand'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { NativeFloatingPanel } from '$lib/native-floating-panel.svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import {
    registerModalPrimaryAction,
    findPanelPrimaryAction,
    findFirstTextField,
    focusOwnsEnter
  } from '$lib/modal-primary-action.svelte'

  interface Props {
    open: boolean
    title: string
    /**
     * Whether the panel is collapsed into its dock row. A docked panel is not an
     * overlay: it renders nothing but its floating chip, so it claims neither
     * Escape nor the close-surface shortcut, and the user restores it from the
     * chip. That keeps Escape free for whatever is actually on view   the
     * composer's double-Escape stop, stopping a recording, closing the surface
     * underneath the chip.
     */
    minimized: boolean
    /**
     * Whether the close (CioClose) affordance is available. When false the header shows
     * only the minimize button, Escape minimizes, and there is no backdrop to
     * dismiss   the panel floats and the app stays usable behind it.
     */
    closable: boolean
    onMinimize: () => void
    onClose: () => void
    /**
     * Content rendered in the dock while minimized. Each dock wraps its chips in
     * `DockRow`, which owns the row's edge placement and its drag head, so a
     * docked panel can be dragged to any screen edge; a dock whose host renders
     * the shared chip row (e.g. the PR or worktree dock) renders nothing here.
     */
    dock: Snippet
    children: Snippet
    footer?: Snippet
    /**
     * LocalStorage key used to persist the panel's position/size.
     */
    storageKey?: string
    /**
     * Stacking layer. `surface` sits with the app's other floating panels at
     * `z-50`. `top` lifts the panel above the full screen surfaces (terminal,
     * browser, file editor and the pull request reader all render through
     * `ui/Modal.svelte` at `z-60`), which the pull request sheet needs because
     * it can be opened from the full screen reader. Portaled menus and confirms
     * inside a `top` panel belong at `z-90` so they still clear the panel
     * itself.
     */
    layer?: 'surface' | 'top'
    /** Initial panel height before viewport clamping. */
    defaultHeight?: number
    /** Tooltip/aria label shown on the draggable header. */
    dragLabel?: string
    /**
     * Extra header controls rendered before the minimize and close affordances,
     * e.g. the file panel's "open full screen" action.
     */
    headerActions?: Snippet
    /**
     * Render the body without its default padding and scroll, as a flex column,
     * for content that lays itself out and fills the panel (an editor or a
     * full-height viewer). The default padded, scrolling body suits prose and
     * lists.
     */
    flushBody?: boolean
    /**
     * Optional content rendered before the title in the header (e.g. a project
     * icon and name), so the panel states which project it belongs to.
     */
    headerPrefix?: Snippet
    /**
     * Lets the panel's owner claim ⌘/Ctrl+Enter before the generic DOM lookup:
     * return true when the chord was handled. Use it when the panel's primary
     * action needs context the DOM cannot express (e.g. "start the work and dock
     * the panel"), so the shortcut never depends on a footer button happening
     * to be enabled.
     */
    onPrimaryAction?: () => boolean
    /**
     * Claim the initial focus when the panel opens. Return true when you focused
     * something.
     *
     * Opt-in, matching `ui/Modal.svelte`'s prop of the same name, because the
     * canonical modal focuses its panel automatically and a docked panel has no
     * such rule of its own: a panel whose content is a live run log or a
     * terminal should not steal the caret. An owner that expects the app's modal
     * convention ("focus the first input field, else the primary button") claims
     * it here and keeps that behavior across the two shells.
     */
    claimInitialFocus?: (panel: HTMLElement) => boolean
  }

  let {
    open,
    title,
    minimized,
    closable,
    onMinimize,
    onClose,
    dock,
    children,
    footer,
    storageKey = `${APP_SLUG}.harnessTasksPanel.v1`,
    layer = 'surface',
    defaultHeight = 560,
    dragLabel = 'Drag to move the task panel',
    headerActions,
    flushBody = false,
    headerPrefix,
    onPrimaryAction,
    claimInitialFocus
  }: Props = $props()

  const PANEL_MARGIN = 12
  const MIN_PANEL_WIDTH = 360
  const MAX_PANEL_WIDTH = 640
  const MIN_PANEL_HEIGHT = 240
  /** The chat composer's `max-w-2xl`   the panel must never cover it by default. */
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
    return Math.max(0, window.innerHeight - PANEL_MARGIN * 2)
  }

  function preferredHeight(): number {
    return Math.max(MIN_PANEL_HEIGHT, defaultHeight)
  }

  /**
   * The gap between the right edge of the chat composer and the right edge of
   * the window (with the left sidebar docked)   the panel's default max width so
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
    ? Math.min(availableWidth(), Math.max(MIN_PANEL_WIDTH, saved.width))
    : Math.min(availableWidth(), preferredWidth())
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
  function onViewportResize(): void {
    if (!open) return
    width = Math.min(width, availableWidth())
    height = Math.min(height, availableHeight())
    position = { x: clampX(position.x, width), y: clampY(position.y, height) }
  }

  function onHeaderPointerDown(event: PointerEvent): void {
    if (minimized || event.button !== 0) return
    // Let the header's own buttons keep their click behavior   never start a drag.
    if (event.target instanceof Element && event.target.closest('button')) return
    dragging = true
    dragStart = { x: event.screenX, y: event.screenY }
    dragOrigin = { x: position.x, y: position.y }
    const target = event.currentTarget
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onHeaderPointerMove(event: PointerEvent): void {
    if (!dragging) return
    position = {
      x: clampX(dragOrigin.x + (event.screenX - dragStart.x), width),
      y: clampY(dragOrigin.y + (event.screenY - dragStart.y), height)
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

  const resizeHandles = [
    { edge: 'n', label: 'top edge', classes: 'top-0 left-3 right-3 h-1 cursor-ns-resize' },
    { edge: 's', label: 'bottom edge', classes: 'bottom-0 left-3 right-3 h-1 cursor-ns-resize' },
    { edge: 'e', label: 'right edge', classes: 'right-0 top-3 bottom-3 w-1 cursor-ew-resize' },
    { edge: 'w', label: 'left edge', classes: 'left-0 top-3 bottom-3 w-1 cursor-ew-resize' },
    { edge: 'nw', label: 'top left corner', classes: 'top-0 left-0 size-3 cursor-nwse-resize' },
    { edge: 'ne', label: 'top right corner', classes: 'top-0 right-0 size-3 cursor-nesw-resize' },
    {
      edge: 'sw',
      label: 'bottom left corner',
      classes: 'bottom-0 left-0 size-3 cursor-nesw-resize'
    },
    {
      edge: 'se',
      label: 'bottom right corner',
      classes: 'bottom-0 right-0 size-3 cursor-nwse-resize'
    }
  ] as const

  let resizeGesture: {
    pointerId: number
    edge: string
    screenX: number
    screenY: number
    bounds: PanelSnapshot
  } | null = null

  function resizePanel(edge: string, bounds: PanelSnapshot, dx: number, dy: number): void {
    const right = bounds.x + bounds.width
    const bottom = bounds.y + bounds.height
    const maxWidth = edge.includes('w')
      ? right - PANEL_MARGIN
      : window.innerWidth - bounds.x - PANEL_MARGIN
    const maxHeight = edge.includes('n')
      ? bottom - PANEL_MARGIN
      : window.innerHeight - bounds.y - PANEL_MARGIN
    if (edge.includes('w') || edge.includes('e')) {
      width = Math.min(
        maxWidth,
        Math.max(
          Math.min(MIN_PANEL_WIDTH, maxWidth),
          bounds.width + (edge.includes('w') ? -dx : dx)
        )
      )
    }
    if (edge.includes('n') || edge.includes('s')) {
      height = Math.min(
        maxHeight,
        Math.max(
          Math.min(MIN_PANEL_HEIGHT, maxHeight),
          bounds.height + (edge.includes('n') ? -dy : dy)
        )
      )
    }
    position = {
      x: edge.includes('w') ? right - width : bounds.x,
      y: edge.includes('n') ? bottom - height : bounds.y
    }
  }

  function onResizePointerDown(event: PointerEvent, edge: string): void {
    if (minimized || event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return
    resizeGesture = {
      pointerId: event.pointerId,
      edge,
      screenX: event.screenX,
      screenY: event.screenY,
      bounds: { ...position, width, height }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }

  function onResizePointerMove(event: PointerEvent): void {
    if (!resizeGesture || resizeGesture.pointerId !== event.pointerId) return
    resizePanel(
      resizeGesture.edge,
      resizeGesture.bounds,
      event.screenX - resizeGesture.screenX,
      event.screenY - resizeGesture.screenY
    )
  }

  function onResizePointerEnd(event: PointerEvent): void {
    if (!resizeGesture || resizeGesture.pointerId !== event.pointerId) return
    resizeGesture = null
    const target = event.currentTarget
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId)
    persistSnapshot()
  }

  function onResizeKeyDown(event: KeyboardEvent, edge: string): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const step = event.shiftKey ? 40 : 10
    resizePanel(
      edge,
      { ...position, width, height },
      event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    )
    event.preventDefault()
    event.stopPropagation()
    persistSnapshot()
  }

  // The Cmd/Ctrl+W "close the active surface" shortcut closes a closable panel
  // and minimizes a pinned one. A docked panel registers nothing: its chip is
  // not an overlay on view, so the shortcut belongs to the surface actually in
  // front of the user, and `isOverlayOpen()` must not keep reporting an overlay
  // for an off-screen chip.
  $effect(() => {
    if (!open || minimized) return
    return registerOverlayClose(() => {
      if (closable) {
        onClose()
      } else {
        onMinimize()
      }
    })
  })

  let panelEl = $state<HTMLElement | null>(null)

  /**
   * The live host that draws this panel above a browser page.
   *
   * A dockable panel floats over whatever is behind it, and the browser's page is
   * a native view the compositor paints above every DOM node of this window. So
   * the panel is drawn by the shared native host while the app window cannot draw
   * it, and the panel here stays the projection source: it never paints while a
   * host can draw it, so it arrives once instead of arriving, vanishing, and
   * arriving again.
   *
   * Arming is deliberately narrow. The host is only used while a browser surface
   * actually owns a page (`canUseNativeDock`), which is the one situation where
   * the app window would otherwise have to park that page to be seen at all. A
   * panel over the workspace keeps the app window's own presentation, which is
   * both faithful and free.
   */
  const native = new NativeFloatingPanel(`dockable-modal-${crypto.randomUUID()}`)
  const nativeArmed = $derived(open && browserVisibility.canUseNativeDock && !native.failed)
  const nativeMount: Attachment<HTMLElement> = (element) => native.mount(element)

  // Restore before the original conditional block removes its node range.
  $effect.pre(() => {
    if (!open) native.restore()
  })

  $effect(() => {
    native.update(nativeArmed, !minimized, { x: position.x, y: position.y, width, height })
  })

  // A collapsed panel is `invisible`, but the DOM keeps focus on whatever was
  // focused inside it. Without this, keystrokes typed after a minimize land in
  // an element the user cannot see (an editor, a terminal), so focus is released
  // to the surface behind the chip the moment the panel collapses.
  $effect(() => {
    if (!minimized) return
    const focused = panelEl?.ownerDocument.activeElement
    if (focused instanceof HTMLElement && panelEl?.contains(focused)) focused.blur()
  })

  /**
   * Apply the canonical modal focus convention on open and dock expansion.
   * The owner can choose a control first; otherwise focus a field, the primary
   * action, or the panel itself, never the minimize or close affordances.
   */
  let claimedInitialFocus = false
  $effect(() => {
    if (!open || minimized) {
      claimedInitialFocus = false
      return
    }
    if (claimedInitialFocus || !panelEl || (nativeArmed && !native.live)) return
    if (!claimInitialFocus?.(panelEl)) {
      ;(findFirstTextField(panelEl) ?? findPanelPrimaryAction(panelEl) ?? panelEl).focus({
        preventScroll: true
      })
    }
    claimedInitialFocus = true
  })

  const occlusionKey = `dockable-modal-${crypto.randomUUID()}`

  // The in-app browser renders a native WebContentsView that the compositor
  // paints above every DOM surface, so a panel floating over the browser frame
  // would be hidden behind the page and unclickable. Publish this panel's
  // on-screen rectangle and let the browser panel detach its native view while
  // it is covered   a panel dragged off the browser leaves the browser usable.
  // The minimized dock row publishes its own rectangle through `DockRow`.
  //
  // While the native host draws the panel there is nothing here to hide behind,
  // so the page stays attached and the panel floats above it. That is the whole
  // point of the host, and a rectangle left behind here would park the page for
  // as long as the panel is open.
  $effect(() => {
    const key = occlusionKey
    if (!open || minimized || nativeArmed) {
      browserVisibility.clearOcclusion(key)
      return () => browserVisibility.clearOcclusion(key)
    }
    // The floating panel is positioned and sized from state, so reading those
    // values here re-publishes on drag, resize, and viewport clamping without a
    // DOM measurement.
    browserVisibility.publishOcclusion(key, { x: position.x, y: position.y, width, height })
    return () => browserVisibility.clearOcclusion(key)
  })

  // ⌘/Ctrl+Enter runs this panel's primary action through the shared LIFO
  // pipeline while the panel is open and expanded (a minimized panel is not in
  // focus, so its resolver yields). The owner hook runs first so a panel can
  // claim the chord deterministically; otherwise the shared selector chain
  // finds the panel's own primary action.
  $effect(() => {
    if (!open || minimized) return
    return registerModalPrimaryAction(() => {
      if (!panelEl || focusOwnsEnter(panelEl)) return false
      if (onPrimaryAction?.()) return true
      const action = findPanelPrimaryAction(panelEl)
      if (!action) return false
      action.click()
      return true
    })
  })
</script>

<svelte:window
  onresize={onViewportResize}
  onkeydown={(e: KeyboardEvent) => {
    // A docked panel deliberately ignores Escape: the chip is not on view, the
    // user restores the panel from it, and the key stays free for everything
    // else that owns Escape behind the chip.
    if (!open || minimized || !keymapState.matches('ui-close-modal', e)) return
    if (closable) {
      onClose()
    } else {
      onMinimize()
    }
  }}
/>

<BitsConfig defaultPortalTo={native.portalTarget ?? document.body}>
  {#if open}
    <!--
    The panel stays mounted in the SAME tree position whether minimized or not so
    its embedded terminal PTYs are never torn down   minimize only hides it while
    the dock row keeps the run badges live. The dock renders as a sibling, outside
    this panel, so the panel's `invisible` state cannot hide it.
  -->
    <!--
    `pointer-events-auto` is load-bearing, not decoration: a modal bits-ui Dialog
    (the full screen reader, terminal, browser, file editor) sets
    `body { pointer-events: none }` while it is open, and pointer events inherit,
    so a panel that does not opt back in is visible above that surface at z-80 but
    completely dead to the mouse. That is the whole reason `layer="top"` exists.
  -->
    <div
      class="fixed {layer === 'top'
        ? 'z-80'
        : 'z-50'} flex flex-col overflow-hidden border bg-surface shadow-xl outline-none {minimized
        ? 'invisible pointer-events-none'
        : 'pointer-events-auto'}"
      style="left: {position.x}px; top: {position.y}px; width: {width}px; height: {height}px;{nativeArmed &&
      !native.live
        ? ' opacity: 0;'
        : ''}"
      bind:this={panelEl}
      {@attach nativeMount}
      role="dialog"
      tabindex="-1"
      aria-label={title}
      onkeydown={(event) => {
        if (event.key !== 'Tab' || !panelEl) return
        const targets = Array.from(
          panelEl.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"], [contenteditable="true"]'
          )
        ).filter((element) => element.checkVisibility() && !element.closest('[inert]'))
        const first = targets[0]
        const last = targets.at(-1)
        const active = panelEl.ownerDocument.activeElement
        if (
          !first ||
          (event.shiftKey
            ? active === first || active === panelEl
            : active === last || active === panelEl)
        ) {
          event.preventDefault()
          ;(event.shiftKey ? (last ?? panelEl) : (first ?? panelEl)).focus({ preventScroll: true })
        }
      }}
    >
      <div
        class="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5 select-none {dragging
          ? 'cursor-grabbing'
          : 'cursor-grab'}"
        data-native-dock-handle
        title={dragLabel}
        aria-label={dragLabel}
        role="group"
        onpointerdown={onHeaderPointerDown}
        onpointermove={onHeaderPointerMove}
        onpointerup={onHeaderPointerUp}
      >
        <span class="flex min-w-0 items-center gap-2">
          <CioGrip size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
          {#if headerPrefix}
            <span class="flex min-w-0 items-center gap-1.5">{@render headerPrefix()}</span>
          {/if}
          <h2 class="truncate text-xs font-semibold">{title}</h2>
        </span>
        <span class="flex shrink-0 items-center gap-1">
          {#if headerActions}
            {@render headerActions()}
          {/if}
          <button
            class="flex h-6 w-6 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
            data-modal-dismiss
            aria-label="Minimize"
            title="Minimize"
            onclick={onMinimize}
          >
            <CioMinus size={14} />
          </button>
          {#if closable}
            <button
              class="flex h-6 w-6 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
              data-modal-dismiss
              aria-label="Close"
              title="Close"
              onclick={onClose}
            >
              <CioClose size={14} />
            </button>
          {/if}
        </span>
      </div>

      <div
        class={flushBody
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'min-h-0 flex-1 overflow-y-auto p-4'}
      >
        {@render children()}
      </div>

      {#if footer}
        <!--
        `flex-wrap` because the footer carries three actions in the pull request
        sheet (compose, dismiss, create). It was sized for two, and at the panel's
        360px minimum width the third would have overflowed the edge instead of
        wrapping to a second row. Panels that already fit are unaffected.
      -->
        <div
          class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-surface px-4 py-3 [&>[data-modal-dismiss]:first-child]:mr-auto"
          data-modal-footer
        >
          {@render footer()}
        </div>
      {/if}
      {#each resizeHandles as handle (handle.edge)}
        <button
          type="button"
          class="absolute z-10 touch-none text-muted hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline focus-visible:outline-primary {handle.classes}"
          title={`Resize ${title} from the ${handle.label}. Use arrow keys to adjust.`}
          aria-label={`Resize ${title} from the ${handle.label}`}
          data-modal-dismiss
          onpointerdown={(event) => onResizePointerDown(event, handle.edge)}
          onpointermove={onResizePointerMove}
          onpointerup={onResizePointerEnd}
          onpointercancel={onResizePointerEnd}
          onlostpointercapture={onResizePointerEnd}
          onkeydown={(event) => onResizeKeyDown(event, handle.edge)}
        >
          {#if handle.edge === 'se'}
            <svg
              viewBox="0 0 12 12"
              class="size-3"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path d="M3 9 9 3M7 9l2-2" />
            </svg>
          {/if}
        </button>
      {/each}
    </div>

    {#if minimized}
      <div class="pointer-events-auto fixed right-4 bottom-4 {layer === 'top' ? 'z-80' : 'z-50'}">
        {@render dock()}
      </div>
    {/if}
  {/if}
</BitsConfig>
