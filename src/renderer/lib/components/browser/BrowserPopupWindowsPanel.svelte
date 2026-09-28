<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { AppWindow, Globe, Loader2, X } from '@lucide/svelte'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
  import type { BrowserPopupWindow, BrowserViewBounds } from '$shared/ipc-contract'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'

  /**
   * The popup windows the tab on screen has open.
   *
   * A popup window is a page's own `window.open` with a window in it (a sign-in,
   * a checkout, a share dialog), and the app owns it: main hosts its page in a
   * native `WebContentsView` rather than letting the operating system open a
   * window. So this panel is a tab strip over one frame, and the frame is where
   * the page of the selected popup is placed, exactly as the browser workspace
   * places a tab's page.
   *
   * Nothing here holds a popup open or closes one: a popup's page ends it by
   * calling `window.close()`, which is what it does when it is done, and main
   * reports that. The close button is the same thing on the user's terms.
   */

  const activeTab = $derived(globalBrowser.activeTab)
  /** This tab's popup windows, in the order the page opened them. */
  const popups = $derived(activeTab ? browserPopupWindows.forTab(activeTab.id) : [])

  /**
   * The popup the panel is showing. The user's pick is remembered by id, and a
   * popup that closes itself (the usual way one ends) hands the panel to the last
   * one still open rather than to none.
   */
  let pickedId = $state<string | null>(null)
  const selected = $derived(
    popups.find((popup) => popup.id === pickedId) ?? popups.at(-1) ?? null
  )

  let frameElement = $state<HTMLDivElement>()
  /**
   * The frame's current on-screen rectangle, refreshed by the observers that keep
   * the native page aligned with it. It is state rather than a local because the
   * visibility decision below re-reads it: the page has to come back as soon as an
   * overlay stops covering the frame, and only a value that can change can say so.
   */
  let frameRect = $state<BrowserViewBounds | null>(null)

  /** Whether the selected popup's page may be on screen right now. The one
   *  decision, from the store that owns every native-view visibility rule: a
   *  full-window DOM surface, the thread switcher or an overlay over this frame
   *  keeps the page off screen. Absent a block, the panel showing this popup is
   *  what puts it up, so it needs no claim of its own. */
  const popupVisible = $derived(selected !== null && browserVisibility.isPopupVisible(frameRect))

  function frameBounds(): BrowserViewBounds | null {
    if (!frameElement) return null
    const rect = frameElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }

  /**
   * Place the selected popup's page over the frame, or leave it where it is when
   * the rail cannot show it right now.
   *
   * Every input is re-read here rather than once at mount: the page comes back
   * after an overlay closes, and a stale placement would leave it floating over
   * the wrong rectangle.
   */
  async function placeSelected(): Promise<void> {
    const popup = selected
    if (!popup) return
    const bounds = frameBounds()
    // Publish the frame before the visibility check, so the derived above sees the
    // rectangle the store has to test an overlay against.
    frameRect = bounds
    if (!bounds) return
    if (!browserVisibility.isPopupVisible(bounds)) return
    browserPopupWindows.show(popup.id, bounds)
  }

  function selectPopup(popup: BrowserPopupWindow): void {
    pickedId = popup.id
    // Picking a popup is the user reaching for it, so it takes the keyboard once
    // its page is up.
    void tick().then(() => browserPopupWindows.focus(popup.id))
  }

  const attachFrame: Attachment<HTMLDivElement> = (element) => {
    frameElement = element
    // Keep the page aligned with the frame it is placed over.
    const observer = new ResizeObserver(() => {
      void placeSelected().catch(() => {})
    })
    observer.observe(element)
    const onWindowResize = (): void => {
      void placeSelected().catch(() => {})
    }
    window.addEventListener('resize', onWindowResize)
    // Follow the frame while it moves.
    //
    // The rail slides open over a couple of hundred milliseconds, and while it
    // does the panel moves without changing size, which is the one thing a
    // ResizeObserver cannot see: without this the page would be placed at the
    // frame the panel had mid-slide and sit a rail's width to the right of it, off
    // the window. The loop re-measures until the rectangle holds still, and is
    // bounded so a frame that never settles cannot leave a loop running.
    let following = true
    let lastKey = ''
    let stableFrames = 0
    let frames = 0
    const follow = (): void => {
      if (!following) return
      const bounds = frameBounds()
      const key = bounds === null ? '' : `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
      if (key === lastKey) stableFrames += 1
      else {
        lastKey = key
        stableFrames = 0
        void placeSelected().catch(() => {})
      }
      frames += 1
      if (stableFrames < 3 && frames < 180) requestAnimationFrame(follow)
    }
    requestAnimationFrame(follow)
    return () => {
      following = false
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      if (frameElement === element) frameElement = undefined
    }
  }

  /**
   * Attach the popup's page while this panel is the surface allowed to show it,
   * and take it off screen the moment that stops being true.
   *
   * Applied conditionally on purpose: a block published by a modal has to detach
   * the page now and re-attach it when it clears, and only a conditional
   * attachment re-runs on that edge.
   */
  const manageNativeView: Attachment<HTMLDivElement> = () => {
    void tick().then(() => placeSelected().catch(() => {}))
    return () => {
      const popup = selected
      // Leaving the frame parks the page rather than ending it: main keeps the
      // popup running, so a sign-in switched away from is still there when the
      // user comes back to it.
      if (popup) browserPopupWindows.hide(popup.id)
    }
  }

  onMount(() => {
    // Read the authoritative list once: a popup that opened before this panel did
    // (or while another tool held the rail) is only reconciled by asking.
    void browserPopupWindows.load(GLOBAL_BROWSER_PROJECT_ID)
  })
</script>

<div class="flex h-full min-h-0 flex-col" data-region="browser-popup-windows">
  {#if popups.length === 0}
    <EmptyState
      icon={AppWindow}
      title="No popup windows"
      description="A page that opens a window, like a sign-in or a checkout, appears here as its own tab. It closes itself when it is done."
    />
  {:else}
    <!-- One tab per popup, over the frame its page is placed in. The strip scrolls
         sideways rather than wrapping, so a page that opens several never pushes
         the frame off the panel. -->
    <div
      class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
      role="tablist"
      aria-label="Popup windows"
    >
      {#each popups as popup (popup.id)}
        <div
          class="group flex shrink-0 items-center rounded-md transition-colors {popup.id ===
          selected?.id
            ? 'bg-elevated'
            : 'hover:bg-overlay'}"
        >
          <button
            type="button"
            role="tab"
            aria-selected={popup.id === selected?.id}
            class="flex max-w-52 min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 text-xs text-foreground outline-none"
            title={popup.title || popup.url || 'Popup window'}
            onclick={() => selectPopup(popup)}
          >
            {#if popup.loading}
              <Loader2 size={12} class="shrink-0 animate-spin text-muted" />
            {:else if popup.favicon}
              <img src={popup.favicon} alt="" class="h-3.5 w-3.5 shrink-0 rounded-sm" />
            {:else}
              <Globe size={12} class="shrink-0 text-muted" />
            {/if}
            <span class="truncate">{popup.title || popup.url || 'Popup window'}</span>
          </button>
          <button
            type="button"
            class="mr-1 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-foreground focus-visible:opacity-100"
            aria-label={`Close ${popup.title || 'popup window'}`}
            title={`Close ${popup.title || 'popup window'}`}
            onclick={() => browserPopupWindows.close(popup.id)}
          >
            <X size={12} />
          </button>
        </div>
      {/each}
    </div>

    <!-- The frame the selected popup's page is placed in. Keyed by popup id, so
         switching popups tears one placement down and builds the next. -->
    {#key selected?.id}
      <div
        {@attach attachFrame}
        {@attach popupVisible && manageNativeView}
        class="relative min-h-0 min-w-0 flex-1 bg-app"
      ></div>
    {/key}
  {/if}
</div>
