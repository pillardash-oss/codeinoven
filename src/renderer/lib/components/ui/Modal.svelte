<script lang="ts">
  import { X } from '@lucide/svelte'
  import { Dialog } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import {
    registerModalPrimaryAction,
    findPanelPrimaryAction,
    focusOwnsEnter,
    isFocusableTarget
  } from '$lib/modal-primary-action.svelte'
  import { isWithinToastLayer } from '$lib/toast-layer'

  /**
   * The canonical modal.
   *
   * Every surface in the app that blocks the window behind it renders through
   * this component, either directly or as a thin variant on top of it
   * (`ConfirmDialog`, `SideSheet`, `BottomSheet`, the full screen editors and
   * readers, the command palettes). One component owns the parts that must
   * never differ between surfaces:
   *
   *   - the portal and the scrim
   *   - the stacking layer (`z-60`), above the app's floating panels
   *   - the panel shell: header, scrolling body, and a footer that never scrolls
   *   - initial focus: the first text field, else the primary action
   *   - Escape, the backdrop, and Cmd/Ctrl+W (`registerOverlayClose`), with
   *     `onEscapeKeydown` letting a surface claim Escape before the shell
   *     dismisses (`preventDefault()` keeps the panel up)
   *   - Cmd/Ctrl+Enter (`registerModalPrimaryAction`)
   *   - browser-view suppression while a full-window surface is up, unless the
   *     surface is the one displaying that view (`blocksBrowserView`)
   *
   * A variant only chooses where its panel sits (`placement`), how wide it is
   * (`size`), and whether it draws the canonical header and footer (`chrome`) or
   * owns its layout. It never re-implements the shell.
   *
   * `ui/DockableModal.svelte` is deliberately not built on this: it is a
   * draggable, dockable, non-blocking panel with no scrim, which is a different
   * contract rather than a placement.
   */
  type ModalPlacement = 'center' | 'right' | 'bottom' | 'palette' | 'fullscreen'
  export type ModalSize = 'md' | 'lg' | 'xl' | 'full'

  const INPUT_FIELD_SELECTOR = [
    'input:not([type="hidden"]):not([disabled]):not([readonly])',
    'textarea:not([disabled]):not([readonly])',
    'select:not([disabled])',
    '[contenteditable="true"]:not([aria-disabled="true"])'
  ].join(',')

  /** The scrim is shared by every placement. A full screen panel covers it. */
  const OVERLAY_CLASS = 'fixed inset-0 z-60 bg-overlay/70 backdrop-blur-[1px]'

  /**
   * How the fixed wrapper positions the panel. Padding lives here rather than on
   * the panel so a centered modal can use `max-h-full` for its viewport clamp.
   */
  const ALIGNMENTS: Record<ModalPlacement, string> = {
    center: 'items-center justify-center p-6',
    palette: 'items-start justify-center px-6 pt-[18vh] pb-6',
    right: 'justify-end',
    bottom: 'items-end',
    fullscreen: ''
  }

  const WIDTHS: Record<ModalSize, string> = {
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-5xl',
    full: 'max-w-none'
  }

  /**
   * Placements whose panel spans the window's width.
   *
   * The width ladder is for a panel that chooses how wide it is (`center`,
   * `palette`, `right`). A full-window surface and a bottom sheet are told to
   * span, so the ladder must not apply at all: otherwise the default `size`
   * silently clamps a `w-full` panel to `max-w-md`, which is exactly the bug
   * that made full screen surfaces render as a narrow column.
   */
  const FULL_WIDTH_PLACEMENTS: ReadonlySet<ModalPlacement> = new Set(['fullscreen', 'bottom'])

  const PANEL_BASE =
    'pointer-events-auto relative flex min-h-0 flex-col overflow-hidden shadow-xl outline-none'

  /** The panel's own geometry: surface, shape, edges, and viewport clamp. The
   *  width comes from `panelWidth` / `size` and is applied separately, so the
   *  panel can never carry two `max-w-*` classes. */
  function panelLayout(placement: ModalPlacement, fill: boolean): string {
    switch (placement) {
      case 'right':
        return 'h-full w-full rounded-none border-l bg-surface'
      case 'bottom':
        return 'max-h-[90dvh] w-full rounded-t-2xl border-t bg-surface pb-[env(safe-area-inset-bottom)]'
      case 'fullscreen':
        return 'h-full w-full'
      default:
        return `w-full max-h-full rounded-2xl border bg-surface ${fill ? 'h-full' : ''}`
    }
  }

  interface Props {
    open: boolean
    /** The panel's accessible name. Rendered in the canonical header, or
     *  screen-reader-only when the surface draws its own header. */
    title: string
    /** A screen-reader-only description of what the modal does, for a surface
     *  whose title alone is not enough. */
    description?: string
    onClose: () => void
    children: Snippet
    /** The fixed action bar. Only rendered with the canonical chrome. */
    footer?: Snippet
    /** Where the panel sits. `palette` is a top-anchored command surface.
     *  `fullscreen` fills the window and paints no surface of its own: a full
     *  screen editor passes `panelClass="bg-app"`, and a media lightbox passes
     *  the translucent backdrop it wants. */
    placement?: ModalPlacement
    size?: ModalSize
    /** An exact panel width class, for a surface whose width does not come from
     *  the `size` ladder. Overrides it rather than stacking on top of it, so
     *  only one `max-w-*` is ever on the panel. Ignored by `fullscreen`, which
     *  is never width-capped. */
    panelWidth?: string
    /** Draw the canonical header (title and close) and footer slot. Off for a
     *  surface that owns its own layout, such as a full screen editor or a
     *  palette. */
    chrome?: boolean
    /** Classes for the scrolling body region, with the canonical chrome. */
    contentClass?: string
    /** Extra classes for the panel itself, applied after the placement's own. */
    panelClass?: string
    /** Make a centered panel fill the viewport's height. */
    fill?: boolean
    /** Clicking the backdrop calls onClose. Off for surfaces that hold drafts. */
    closeOnBackdrop?: boolean
    /** Keep Tab inside the panel. Off for a full screen surface that hosts
     *  floating panels above itself, which must be able to take focus. */
    trapFocus?: boolean
    /** Whether Escape dismisses. Off for a surface that owns Escape itself. */
    escapeCloses?: boolean
    /** Inspect Escape before the shell decides. The shell dismisses only when
     *  the event is not prevented, so a surface whose Escape means "go back"
     *  calls `preventDefault()` and takes over. Only the topmost layer is ever
     *  called, so a popover opened inside the panel still closes on its own. */
    onEscapeKeydown?: (event: KeyboardEvent) => void
    /** Detach the browser's native view while this modal is open.
     *
     *  The native view floats above every DOM surface, so a modal that does not
     *  detach it is covered by whatever the browser was last showing. On by
     *  default for every surface that paints over the workspace. Off for the one
     *  surface that hosts the view itself: the full screen browser must not
     *  suppress the very page it exists to display. */
    blocksBrowserView?: boolean
    /** Claim the initial focus. Return true when you focused something. */
    claimInitialFocus?: (panel: HTMLElement) => boolean
    /** Runs as the panel closes, before focus is restored. Call
     *  `preventDefault()` to restore a target of your own. */
    onCloseAutoFocus?: (event: Event) => void
    /** The panel element. Bind it when a variant needs to query inside its own
     *  panel, such as a palette that focuses a specific row. */
    panelEl?: HTMLElement | null
  }

  let {
    open,
    title,
    description,
    onClose,
    children,
    footer,
    placement = 'center',
    size = 'md',
    panelWidth,
    chrome = true,
    contentClass = 'overflow-y-auto p-6',
    panelClass = '',
    fill = false,
    closeOnBackdrop = true,
    trapFocus = true,
    escapeCloses = true,
    onEscapeKeydown,
    blocksBrowserView = true,
    claimInitialFocus,
    onCloseAutoFocus,
    panelEl = $bindable(null)
  }: Props = $props()

  let alignment = $derived(ALIGNMENTS[placement])
  let layout = $derived(panelLayout(placement, fill))
  let widthClass = $derived(
    FULL_WIDTH_PLACEMENTS.has(placement) ? '' : (panelWidth ?? WIDTHS[size])
  )

  // The browser's native view floats above every DOM surface (see
  // browserVisibility.hideWhile), so this shared modal must
  // suppress it while open   otherwise a still-visible browser tab covers the
  // dialog's content and footer buttons, making them unclickable. Keyed per
  // instance so stacked modals don't clear each other's suppression.
  //
  // `blocksBrowserView` is false for the full screen browser, which displays the
  // native view itself: suppressing it there leaves the surface empty. Its own
  // panel claims the view through the store, so nothing else is left uncovered.
  const suppressionKey = `modal-${Math.random().toString(36).slice(2)}`
  $effect(() =>
    browserVisibility.hideWhile(suppressionKey, 'fullscreen-surface', open && blocksBrowserView)
  )

  $effect(() => {
    if (!open) return
    return registerOverlayClose(() => onClose())
  })

  // ⌘/Ctrl+Enter runs this modal's primary action. This instance registers a
  // resolver on the shared LIFO stack while open, so the shortcut always
  // activates the topmost (focused) modal's action.
  $effect(() => {
    if (!open) return
    return registerModalPrimaryAction(() => {
      if (!panelEl || focusOwnsEnter(panelEl)) return false
      const action = findPanelPrimaryAction(panelEl)
      if (!action) return false
      action.click()
      return true
    })
  })

  function focusInitialElement(event: Event) {
    // Own the initial focus (input field, else the primary action) instead
    // of bits-ui's default of focusing the panel itself.
    event.preventDefault()
    if (!panelEl) return
    if (claimInitialFocus?.(panelEl)) return
    const inputField = firstTextField(panelEl)
    const defaultAction = findPanelPrimaryAction(panelEl)
    ;(inputField ?? defaultAction)?.focus({ preventScroll: true })
  }

  function firstTextField(panel: HTMLElement): HTMLElement | undefined {
    return Array.from(panel.querySelectorAll<HTMLElement>(INPUT_FIELD_SELECTOR)).find(
      isFocusableTarget
    )
  }
</script>

<Dialog.Root {open} onOpenChange={(next) => !next && onClose()}>
  <Dialog.Portal>
    <Dialog.Overlay class={OVERLAY_CLASS} />
    <div class="pointer-events-none fixed inset-0 z-60 flex {alignment}">
      <Dialog.Content
        bind:ref={panelEl}
        {trapFocus}
        onOpenAutoFocus={focusInitialElement}
        {onCloseAutoFocus}
        onEscapeKeydown={(event) => {
          onEscapeKeydown?.(event)
          if (!escapeCloses) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          // A toast is drawn above this modal (svelte-sonner stacks at
          // `z-index: 999999999`) and stays interactive there, so a press that
          // lands on one is not a backdrop press. Without this the pointerdown
          // bubbled to the dismissible layer and dismissed the modal as well as
          // the toast it was aimed at: pressing a toast's close button threw the
          // full screen surface away behind it.
          if (isWithinToastLayer(event.target)) event.preventDefault()
          if (!closeOnBackdrop) event.preventDefault()
        }}
        class="{PANEL_BASE} {layout} {widthClass} {panelClass}"
      >
        {#if chrome}
          <div class="flex shrink-0 items-center justify-between border-b px-6 py-4">
            <Dialog.Title class="text-base font-semibold">{title}</Dialog.Title>
            {#if description}
              <Dialog.Description class="sr-only">{description}</Dialog.Description>
            {/if}
            <Dialog.Close
              class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Close"
              title="Close"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          <div class="min-h-0 flex-1 {contentClass}">
            {@render children()}
          </div>

          {#if footer}
            <div
              class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-surface px-6 py-4"
              data-modal-footer
            >
              {@render footer()}
            </div>
          {/if}
        {:else}
          <!-- A surface with its own header still needs a dialog name, so the
               title is rendered here, out of sight, exactly once. -->
          <Dialog.Title class="sr-only">{title}</Dialog.Title>
          {#if description}
            <Dialog.Description class="sr-only">{description}</Dialog.Description>
          {/if}
          {@render children()}
        {/if}
      </Dialog.Content>
    </div>
  </Dialog.Portal>
</Dialog.Root>
