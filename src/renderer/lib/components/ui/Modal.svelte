<script lang="ts">
  import CioClose from '@codeio/icon/CioClose.svelte'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import { Dialog } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { fade, fly } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import { NativeDockController } from '$lib/native-dock-controller.svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import {
    registerModalPrimaryAction,
    findPanelPrimaryAction,
    focusOwnsEnter,
    isFocusableTarget
  } from '$lib/modal-primary-action.svelte'
  import { isWithinLayerAboveModal } from '$lib/layer-above-modal'

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
   *   - the stacking layer, with palettes able to rise above page surfaces
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
    // A colour well is a control, not a field: it must not take the initial
    // focus away from the first real entry the user has to make.
    'input:not([type="hidden"]):not([type="color"]):not([disabled]):not([readonly])',
    'textarea:not([disabled]):not([readonly])',
    'select:not([disabled])',
    '[contenteditable="true"]:not([aria-disabled="true"])'
  ].join(',')

  /** The scrim is shared by every placement. A full screen panel covers it. */
  const OVERLAY_CLASS = 'fixed inset-0 bg-overlay/70 backdrop-blur-[1px]'

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
        return 'h-full w-full border-l bg-surface'
      case 'bottom':
        return 'max-h-[90dvh] w-full border-t bg-surface pb-[env(safe-area-inset-bottom)]'
      case 'fullscreen':
        return 'h-dvh w-dvw max-h-none max-w-none'
      default:
        return `w-full max-h-full border bg-surface ${fill ? 'h-full' : ''}`
    }
  }

  interface Props {
    open: boolean
    /** Nonmodal browser peek leaves the surrounding app interactive. */
    modal?: boolean
    /** Optional viewport rectangle limiting a non-fullscreen shell to a page frame. */
    bounds?: BrowserViewBounds | null
    /** The panel's accessible name. Rendered in the canonical header, or
     *  screen-reader-only when the surface draws its own header. */
    title: string
    /** A screen-reader-only description of what the modal does, for a surface
     *  whose title alone is not enough. */
    description?: string
    onClose: () => void
    /** Override Cmd/Mod+W without changing backdrop or Escape dismissal. */
    onCloseShortcut?: () => void
    children: Snippet
    /**
     * Actions that sit in the canonical header beside the close control.
     *
     * A surface whose one or two actions belong to the panel itself (a viewer
     * that toggles a mode) puts them here rather than in a footer bar, which
     * would add a whole band for a single control. Only rendered with the
     * canonical chrome.
     */
    headerActions?: Snippet
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
    /** Draw the dimmed scrim behind the panel. On by default.
     *
     *  Off for a full screen surface that covers the window with an opaque
     *  panel over continuously repainting content (the browser's native view,
     *  the terminal's renderer). There the scrim is invisible, and its
     *  full-window `backdrop-blur` is a second GPU-composited layer under the
     *  content that keeps painting. On a surface painting hard (a site's own
     *  modal, an animation, a video, a terminal being scrolled) that extra
     *  layer starves the compositor and the content visibly tears, which is why
     *  the same content is smooth in the narrow sidebar and torn at full size. */
    scrim?: boolean
    /** Detach the browser's native view while this modal is open.
     *
     *  The native view floats above every DOM surface, so a modal that does not
     *  detach it is covered by whatever the browser was last showing. On by
     *  default for every surface that paints over the workspace. Off for the one
     *  surface that hosts the view itself: the full screen browser must not
     *  suppress the very page it exists to display. */
    blocksBrowserView?: boolean
    /** Render above browser page shells and Peek flight animations. */
    abovePage?: boolean
    /** Stable identity for a custom native presentation, such as the switcher.
     * Otherwise complete button dialogs automatically use native presentation. */
    nativeOverlay?: string
    /** Keep typing surfaces in one document throughout their screen changes. */
    nativePresentation?: boolean
    nativeReady?: boolean
    nativeFailed?: boolean
    onNativeHover?: (control: HTMLElement) => void
    onNativeCommit?: (key: string) => void
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
    modal = true,
    bounds = null,
    title,
    description,
    onClose,
    onCloseShortcut,
    children,
    headerActions,
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
    scrim = true,
    blocksBrowserView = true,
    abovePage = false,
    nativeOverlay,
    nativePresentation = true,
    nativeReady = $bindable(false),
    nativeFailed = $bindable(false),
    onNativeHover,
    onNativeCommit,
    claimInitialFocus,
    onCloseAutoFocus,
    panelEl = $bindable(null)
  }: Props = $props()

  let panelPresent = $state(false)
  const trackPresentation: Attachment<HTMLElement> = () => {
    panelPresent = true
    return () => {
      panelPresent = false
    }
  }
  const suppressionKey = `modal-${crypto.randomUUID()}`
  const nativeId = $derived(
    nativePresentation
      ? (nativeOverlay ??
          (modal && blocksBrowserView && placement !== 'fullscreen' ? suppressionKey : undefined))
      : undefined
  )
  const frameBounds = $derived(placement === 'fullscreen' ? null : bounds)

  /**
   * Whether the native host, not this component's own DOM panel, is the
   * presentation on screen.
   *
   * A modal the host can draw is projected into the overlay window, which sits
   * above the browser's native page view. Painting the DOM panel as well shows
   * it *behind* that page: the panel and its scrim land in the app window's DOM,
   * which the page composites over, so the user sees the dimmed chrome around the
   * page, then the panel vanish and reappear the moment the host takes over.
   *
   * The DOM panel is therefore the projection source only while the host can draw
   * it, and becomes the presentation the moment it cannot. Nothing else decides
   * this: a half-drawn handover is exactly the double appearance.
   */
  const nativeProjected = $derived(nativeId !== undefined && !nativeFailed)
  const domPresented = $derived(!nativeProjected)

  /**
   * Whether this component's own DOM must be kept out of reach.
   *
   * While the native document draws the panel it owns the pointer and the
   * keyboard, and before it draws the panel is not on screen at all. Either way
   * nothing here may be focused or pressed, so Tab cannot wander into a copy the
   * user cannot see.
   */
  const sourceInert = $derived(nativeProjected || nativeReady)

  function nativePanel(id: string): Attachment<HTMLElement> {
    return (panel) => {
      nativeReady = false
      nativeFailed = false
      const bounds = (): BrowserViewBounds => {
        const rect = panel.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      const controller = new NativeDockController(id, () => {}, bounds, false, {
        onHover: (control) => onNativeHover?.(control),
        onDismiss: () => {
          if (closeOnBackdrop) onClose()
        },
        onCommit: (key) => onNativeCommit?.(key),
        onReady: () => {
          nativeReady = true
        },
        onFailure: () => {
          nativeReady = false
          nativeFailed = true
        },
        requireCompleteProjection: !nativeOverlay,
        onKey: (event) => {
          if (event.type === 'keydown' && event.key === 'Escape') {
            onEscapeKeydown?.(event)
            if (escapeCloses && !event.defaultPrevented) onClose()
            return true
          }
          // Everything else belongs to the source. The forwarded key is
          // dispatched on the element the native document has focused, so a
          // list, an editor and every shortcut handler receive it exactly as
          // they would in the app window. Claiming these keys here is what made
          // arrow navigation dead in every natively drawn dialog.
          return false
        }
      })
      const cleanup = controller.mount(panel)
      const update = (): void => controller.update(true, bounds())
      const observer = new ResizeObserver(update)
      observer.observe(panel)
      window.addEventListener('resize', update)
      queueMicrotask(update)
      return () => {
        observer.disconnect()
        window.removeEventListener('resize', update)
        cleanup()
        // `nativeReady` is deliberately left alone here. Clearing it while the
        // dialog tears down flips the scrim's condition back on, and the overlay
        // that condition renders is inserted into the portal after the portal's
        // own node has already left the document: it survives as an orphan
        // full-window scrim that swallows every click until the app reloads. The
        // next mount clears it again before the panel is shown.
      }
    }
  }

  const stackingClass = $derived(abovePage ? 'z-80' : 'z-60')
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
  $effect(() =>
    browserVisibility.hideWhile(
      suppressionKey,
      'fullscreen-surface',
      (open || panelPresent) && (nativeId ? nativeFailed : blocksBrowserView)
    )
  )

  $effect(() => {
    if (!open) return
    return registerOverlayClose(() => (onCloseShortcut ?? onClose)(), modal)
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

  // The DOM panel becomes the presentation whenever the native host cannot draw
  // the dialog   the common case being a native dialog whose content changed
  // into something the projection refuses. bits-ui's open-autofocus ran once,
  // when the dialog first opened, so a handover would otherwise leave the panel
  // on screen with nothing focused and the user reaching for the mouse. Focus
  // the initial element here, but only when nothing inside the panel already
  // holds it, so a user who tabbed to a control keeps it.
  $effect(() => {
    if (!open || !domPresented || !panelPresent) return
    const panel = panelEl
    if (!panel || panel.contains(document.activeElement)) return
    focusPrimary(panel)
  })

  function focusPrimary(panel: HTMLElement): void {
    // Own the initial focus (input field, else the primary action) instead
    // of bits-ui's default of focusing the panel itself.
    if (claimInitialFocus?.(panel)) return
    const inputField = firstTextField(panel)
    const defaultAction = findPanelPrimaryAction(panel)
    ;(inputField ?? defaultAction)?.focus({ preventScroll: true })
  }

  function focusInitialElement(event: Event) {
    event.preventDefault()
    if (panelEl) focusPrimary(panelEl)
  }

  function firstTextField(panel: HTMLElement): HTMLElement | undefined {
    return Array.from(panel.querySelectorAll<HTMLElement>(INPUT_FIELD_SELECTOR)).find((element) =>
      isFocusableTarget(element, panel)
    )
  }
</script>

<Dialog.Root {open} onOpenChange={(next) => !next && onClose()}>
  {#if open}
    <Dialog.Portal>
      <!-- Only an open dialog may paint a scrim: a scrim rendered on the way out
         would be inserted into a portal that is already leaving the document and
         would stay behind covering the whole window. -->
      {#if scrim && domPresented}
        <Dialog.Overlay forceMount>
          {#snippet child({ props })}
            <div
              {...props}
              class="{OVERLAY_CLASS} {stackingClass}"
              transition:fade|global={{ duration: prefersReducedMotion.current ? 0 : 140 }}
            ></div>
          {/snippet}
        </Dialog.Overlay>
      {/if}
      <div
        inert={sourceInert || undefined}
        class="pointer-events-none fixed {stackingClass} flex {frameBounds
          ? ''
          : 'inset-0'} {alignment}"
        style:opacity={domPresented ? undefined : 0}
        style={frameBounds
          ? `left: ${frameBounds.x}px; top: ${frameBounds.y}px; width: ${frameBounds.width}px; height: ${frameBounds.height}px;`
          : undefined}
      >
        <Dialog.Content
          forceMount
          bind:ref={panelEl}
          trapFocus={trapFocus && domPresented}
          preventScroll={modal}
          preventOverflowTextSelection={modal}
          onOpenAutoFocus={focusInitialElement}
          {onCloseAutoFocus}
          onEscapeKeydown={(event) => {
            onEscapeKeydown?.(event)
            if (!escapeCloses) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            // A toast (svelte-sonner stacks at `z-index: 999999999`) and Vite's
            // development compile-error overlay both draw above this modal and
            // stay interactive there, so a press that lands on either is not a
            // backdrop press. Without this the pointerdown bubbled to the
            // dismissible layer and dismissed the modal as well as the layer it
            // was aimed at: pressing a toast's close button threw the full
            // screen surface away behind it, and dismissing the dev error card
            // took the modal down with it.
            if (isWithinLayerAboveModal(event.target)) event.preventDefault()
            if (!closeOnBackdrop) event.preventDefault()
          }}
          class="{PANEL_BASE} {layout} {widthClass} {panelClass}"
        >
          {#snippet child({ props })}
            <div
              {...props}
              aria-modal={modal}
              {@attach trackPresentation}
              {@attach nativeId ? nativePanel(nativeId) : undefined}
              transition:fly|global={{
                duration: prefersReducedMotion.current || nativeProjected ? 0 : 140,
                y: placement === 'fullscreen' ? 0 : 4
              }}
            >
              {#if chrome}
                <!-- A fullscreen panel is the window, so its canonical header doubles
                     as the title bar. It reserves the OS window-control inset so the
                     title never sits underneath the macOS traffic lights, and it is a
                     fixed `h-12` like the app header and the fullscreen file editor, so
                     the title centres on the same band the traffic lights sit in.
                     Every other placement draws a panel inset from the window edge,
                     where the controls are outside it: it keeps the intrinsic `py-4`
                     that matches the header of every centred dialog. -->
                <div
                  class={[
                    'flex shrink-0 items-center justify-between border-b px-6',
                    placement === 'fullscreen' ? 'h-12' : 'py-4'
                  ]}
                  style={placement === 'fullscreen'
                    ? trafficLightInsetStyle({ mirrorRightInset: false })
                    : undefined}
                >
                  <Dialog.Title class="text-base font-semibold">{title}</Dialog.Title>
                  {#if description}
                    <Dialog.Description class="sr-only">{description}</Dialog.Description>
                  {/if}
                  <div class="flex items-center gap-1">
                    {#if headerActions}
                      {@render headerActions()}
                    {/if}
                    <Dialog.Close
                      class="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      aria-label="Close"
                      title="Close"
                    >
                      <CioClose size={16} />
                    </Dialog.Close>
                  </div>
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
            </div>
          {/snippet}
        </Dialog.Content>
      </div>
    </Dialog.Portal>
  {/if}
</Dialog.Root>
