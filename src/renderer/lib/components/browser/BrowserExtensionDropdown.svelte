<script lang="ts">
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import { browserExtensionDropdown } from '$lib/stores/browser-extension-dropdown.svelte'
  import { browserExtensions } from '$lib/stores/browser-extensions.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'

  /**
   * One extension's own popup, dropped out of the thread browser's toolbar.
   *
   * A browser draws an extension's action popup under the extension's icon and
   * sizes it to what the extension laid out, so this is a frame of exactly that
   * size under the extension button, with the extension's document placed over it.
   * Nothing here draws the popup: main owns the page in a native `WebContentsView`,
   * the same page the global browser shows in its rail, and this only measures the
   * frame and hands it over.
   *
   * The card is the frame and nothing else, because the page composites above every
   * DOM node: a border, a header or a footer drawn here would be hidden under the
   * page it was meant to sit beside. Whatever chrome the popup wants, the extension
   * draws it itself.
   */

  interface Props {
    /** The tab whose toolbar opened this, so a panel for another tab draws none. */
    tabId: string
    /**
     * The extension button, which the card hangs under.
     *
     * Handed over rather than looked up: the button belongs to the panel's toolbar
     * and this has no other business knowing where it is.
     */
    anchor: HTMLElement | undefined
  }

  let { tabId, anchor }: Props = $props()

  /** The smallest a popup may be drawn, which is Chrome's own floor. */
  const MIN_WIDTH = 240
  const MIN_HEIGHT = 160
  /** What a popup is drawn at until its own document has reported a size. */
  const DEFAULT_WIDTH = 380
  const DEFAULT_HEIGHT = 480
  /** The gap between the button and the card, and the margin kept at the edges. */
  const OFFSET = 6
  const EDGE = 8
  const open = $derived(browserExtensionDropdown.forTab(tabId))
  const popup = $derived(open ? browserPopupWindows.find(open.popupId) : null)
  const extension = $derived(
    open
      ? (browserExtensions.extensions.find((candidate) => candidate.id === open.extensionId) ??
          null)
      : null
  )

  /**
   * Where the button is, in viewport coordinates, and how much room is left under
   * it.
   *
   * Measured rather than laid out by the toolbar, and drawn at a fixed position,
   * because the panel sits inside the context sidebar's own clipped column: an
   * absolutely positioned card would be cut off at the row it starts in. The card
   * is therefore placed in the window's space, the same space the native page it
   * hosts is placed in.
   */
  let anchorBox = $state<{ right: number; bottom: number } | null>(null)
  let availableHeight = $state(DEFAULT_HEIGHT)

  const width = $derived(
    Math.max(MIN_WIDTH, Math.round(popup?.preferredViewport?.width ?? DEFAULT_WIDTH))
  )
  const height = $derived(
    Math.max(
      MIN_HEIGHT,
      Math.min(Math.round(popup?.preferredViewport?.height ?? DEFAULT_HEIGHT), availableHeight)
    )
  )
  /** Right-aligned to the button, the way a toolbar's own popup drops, and kept
   *  inside the window when the button is too close to either edge. */
  const cardLeft = $derived(
    anchorBox === null
      ? EDGE
      : Math.max(EDGE, Math.min(anchorBox.right - width, window.innerWidth - width - EDGE))
  )
  const cardTop = $derived(anchorBox === null ? 0 : Math.round(anchorBox.bottom) + OFFSET)

  let cardElement = $state<HTMLDivElement>()
  let frameElement = $state<HTMLDivElement>()
  /**
   * The frame's current on-screen rectangle. State rather than a local because the
   * visibility decision below re-reads it: the page has to come back as soon as an
   * overlay stops covering the card, and only a value that can change can say so.
   */
  let frameRect = $state<BrowserViewBounds | null>(null)
  /** The popup this mount has already handed the keyboard to. */
  let focusedPopupId = $state<string | null>(null)
  /** The popup whose page this mount has actually seen, so a list that has not
   *  reported it yet is not mistaken for the popup having gone away. */
  let seenPopupId = $state<string | null>(null)

  /** Whether the extension's page may be on screen right now: a full-window DOM
   *  surface or the thread switcher in front of the card keeps it off screen. */
  const frameVisible = $derived(
    popup !== null && frameRect !== null && browserVisibility.isPopupVisible(frameRect)
  )

  function frameBounds(): BrowserViewBounds | null {
    const frame = frameElement
    if (!frame) return null
    const rect = frame.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }

  /**
   * Re-read the button's place, and the room left between it and the bottom of the
   * window. A popup taller than that room is cropped by the desktop rather than
   * scrolled by the app, so the card stops where the screen does.
   */
  function measureAnchor(): void {
    if (!anchor) {
      anchorBox = null
      availableHeight = DEFAULT_HEIGHT
      return
    }
    const rect = anchor.getBoundingClientRect()
    anchorBox = { right: rect.right, bottom: rect.bottom }
    availableHeight = Math.max(MIN_HEIGHT, Math.round(window.innerHeight - rect.bottom - 16))
  }

  /**
   * Place one popup's page over the card, or leave it where it is when a surface
   * owns the screen right now.
   *
   * Every input is re-read here rather than once at mount: the popup's own size
   * arrives after its document has laid out, and a stale placement would leave the
   * page floating over a frame the card no longer occupies.
   */
  async function placePopup(shownId: string): Promise<void> {
    if (!browserPopupWindows.find(shownId)) return
    const bounds = frameBounds()
    // The rectangle is published before the visibility check, so the derived above
    // sees the frame the store has to test an overlay against.
    frameRect = bounds
    if (!bounds) return
    if (!browserVisibility.isPopupVisible(bounds)) return
    browserPopupWindows.show(shownId, bounds)
    // Opening a popup is the user reaching for it, so it takes the keyboard the way
    // a browser's own action popup does. Only the first placement does it, so a
    // resize does not pull the keyboard out from under the page.
    if (focusedPopupId !== shownId) {
      focusedPopupId = shownId
      browserPopupWindows.focus(shownId)
    }
  }

  /** Keep the card under a button that moves with the window or the rail. */
  $effect(() => {
    measureAnchor()
    const onResize = (): void => {
      measureAnchor()
      const current = open
      if (current) void tick().then(() => placePopup(current.popupId).catch(() => {}))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  /**
   * Follow the button until it settles.
   *
   * The sidebar enters with a short transform, so a dropdown opened while the rail
   * is still moving would otherwise be pinned to where the button was on the first
   * frame. The loop is bounded to the length of that entry and stops on its own.
   */
  $effect(() => {
    if (!open) return
    let frame = 0
    const startedAt = performance.now()
    const follow = (now: number): void => {
      measureAnchor()
      if (now - startedAt < 260) frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(frame)
  })

  /** Place the page whenever the card it sits on is new or has changed size. */
  $effect(() => {
    const current = open
    if (!current) return
    void tick().then(() => placePopup(current.popupId).catch(() => {}))
  })

  /**
   * Follow the popup itself: a size it reports after its document settled moves the
   * card, and a popup that ends takes the dropdown with it, exactly as dismissing
   * one does.
   */
  $effect(() => {
    const current = open
    if (!current) return
    if (popup === null) {
      if (seenPopupId === current.popupId) browserExtensionDropdown.close()
      return
    }
    seenPopupId = current.popupId
    void tick().then(() => placePopup(current.popupId).catch(() => {}))
  })

  /**
   * Closing is the user's: a click anywhere outside the card and out of the button
   * that opens it, or Escape. A click inside the card never reaches the DOM, because
   * the extension's page is a native view above it, so no handler here sees the page
   * the user is working in.
   */
  $effect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (cardElement?.contains(target)) return
      if (anchor?.contains(target)) return
      browserExtensionDropdown.close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      browserExtensionDropdown.close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  })

  /** A dropdown never outlives the panel it dropped out of. */
  $effect(() => {
    return () => browserExtensionDropdown.close()
  })

  /** Size the frame's page to the card it sits on. */
  const attachFrame: Attachment<HTMLDivElement> = (element) => {
    frameElement = element
    const shownId = open?.popupId
    if (!shownId) return
    void tick().then(() => placePopup(shownId).catch(() => {}))
    const observer = new ResizeObserver(() => {
      void placePopup(shownId).catch(() => {})
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frameElement === element) frameElement = undefined
      frameRect = null
    }
  }

  /**
   * Show the popup's page only while it may be on screen, and take it off again the
   * moment a DOM surface takes the front.
   *
   * Applied conditionally on purpose: a published block has to detach the page now
   * and re-attach it when it clears, and only a conditional attachment re-runs on
   * that edge.
   */
  const manageNativePage: Attachment<HTMLDivElement> = () => {
    const shownId = open?.popupId
    if (!shownId) return
    void tick().then(() => placePopup(shownId).catch(() => {}))
    return () => {
      // Leaving the card parks the page rather than ending it: main keeps an
      // extension's popup alive for as long as its jar runs.
      browserPopupWindows.hide(shownId)
    }
  }
</script>

{#if open && popup && anchorBox}
  <!-- Placed in the window's own coordinates rather than laid out by the toolbar: the
       panel sits inside the sidebar's clipped column, and the native page this hosts is
       placed in the same space.

       No border, background or shadow of its own: the extension's document is a native
       view composited above every DOM node, so a frame drawn here would be covered by
       the very page it was drawn for. The popup is its own surface, exactly as it is in
       a browser whose toolbar only draws the icon that opened it. -->
  <div
    bind:this={cardElement}
    class="fixed z-50"
    style="left: {cardLeft}px; top: {cardTop}px; width: {width}px; height: {height}px"
    data-region="browser-extension-dropdown"
    aria-label={`${extension?.name ?? 'Extension'} popup`}
  >
    <!-- Keyed by popup, so switching extensions tears one placement down and builds
         the next instead of moving a page that is already on screen. -->
    {#key open.popupId}
      <div
        {@attach attachFrame}
        {@attach frameVisible && manageNativePage}
        class="h-full w-full"
      ></div>
    {/key}
  </div>
{/if}
