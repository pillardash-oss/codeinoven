<script lang="ts">
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { AppWindow } from '@lucide/svelte'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'

  /**
   * One popup window's page, filling the rail.
   *
   * A popup window is a page's own `window.open` with a window in it (a sign-in,
   * a checkout, a share dialog), and main owns it: the app hosts its page in a
   * native `WebContentsView` rather than letting the operating system open a
   * window. So this panel is one frame and nothing else. The strip above it, the
   * close of a single window and the close of all of them belong to the rail's
   * own tab strip, exactly as they do for a thread's note or an agent chat; a
   * second toolbar here was one row too many and a second place to keep the list.
   *
   * Nothing here holds a popup open or closes one: a popup's page ends it by
   * calling `window.close()`, which is what it does when it is done, and main
   * reports that, which takes the window's tab out of the strip with it. An
   * extension's popup is closed the same way, from the rail's own strip.
   *
   * The panel follows the browser-wide popup rail, independent of the selected tab
   * or box. The empty state below is only the frame between the last window ending
   * and the rail closing after it.
   */

  interface Props {
    /**
     * The popup window to display. Empty when the rail has no popup to show, which
     * is the frame or two between the last window ending and the rail closing
     * after it, so the panel can be rendered unconditionally by its owner.
     */
    popupId: string
  }

  let { popupId }: Props = $props()

  const popup = $derived(browserPopupWindows.find(popupId))

  let frameElement = $state<HTMLDivElement>()
  /**
   * The frame's current on-screen rectangle, refreshed by the observers that keep
   * the native page aligned with it. It is state rather than a local because the
   * visibility decision below re-reads it: the page has to come back as soon as an
   * overlay stops covering the frame, and only a value that can change can say so.
   */
  let frameRect = $state<BrowserViewBounds | null>(null)
  /** The popup this mount has already handed the keyboard to. Held by id rather
   *  than a flag, because the panel outlives the switch between two windows. */
  let focusedPopupId = $state<string | null>(null)

  /** Whether the popup's page may be on screen right now. The one decision, from
   *  the store that owns every native-view visibility rule: a full-window DOM
   *  surface, the thread switcher or an overlay over this frame keeps the page off
   *  screen. Absent a block, the rail showing this popup is what puts it up, so it
   *  needs no claim of its own. */
  const frameVisible = $derived(popup !== null && browserVisibility.isPopupVisible(frameRect))

  /** This popup's entry in the store's list of native rectangles on screen. */
  const nativeFrameKey = $derived(`native-popup-${popupId}`)

  /**
   * Report this popup's rectangle while its page is really on screen, which is
   * what lets the toaster's corner check see that a page covers it. A popup
   * behind a modal, or one the rail is not showing, publishes nothing.
   */
  $effect(() => {
    const key = nativeFrameKey
    const frame = frameVisible ? frameRect : null
    if (!frame) {
      browserVisibility.clearNativeFrame(key)
      return
    }
    browserVisibility.publishNativeFrame(key, frame)
    return () => browserVisibility.clearNativeFrame(key)
  })

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
   * Place one popup's page over the frame, or leave it where it is when the rail
   * cannot show it right now.
   *
   * Every input is re-read here rather than once at mount: the page comes back
   * after an overlay closes, and a stale placement would leave it floating over
   * the wrong rectangle.
   */
  async function placePopup(shownId: string): Promise<void> {
    if (!browserPopupWindows.find(shownId)) return
    const bounds = frameBounds()
    // Publish the frame before the visibility check, so the derived above sees the
    // rectangle the store has to test an overlay against.
    frameRect = bounds
    if (!bounds) return
    if (!browserVisibility.isPopupVisible(bounds)) return
    browserPopupWindows.show(shownId, bounds)
    // Showing a popup is the user reaching for it, so it takes the keyboard   the
    // same thing a browser does when a window opens or a tab is picked. Only the
    // first placement of a window does it, so following the rail's own opening and
    // coming back from behind a modal never pull the keyboard out from under
    // whatever the user moved on to.
    if (focusedPopupId !== shownId) {
      focusedPopupId = shownId
      browserPopupWindows.focus(shownId)
    }
  }

  /**
   * Re-place the page whenever the rail's width changes.
   *
   * The rail is laid out from the store, and every change also moves the frame:
   * a move without a size change is the one thing a ResizeObserver cannot see,
   * and the rail's own width is the single input every such move flows from.
   * Reading it here places the page on the frame the rail has just settled on
   * instead of whenever an observer callback happens to land.
   */
  $effect(() => {
    void contextSidebarState.width
    if (!frameElement) return
    void tick().then(() => placePopup(popupId).catch(() => {}))
  })

  const attachFrame = (shownId: string): Attachment<HTMLDivElement> => {
    return (element) => {
      frameElement = element
      // Keep the page aligned with the frame it is placed over, and keep the
      // follow alive across changes: a rail that is still easing into its width
      // moves the frame after the last observer callback, and a page left at a
      // rectangle a drag passed through would sit where the frame no longer is.
      // Every resize restarts the tail, so the page ends on the rectangle the
      // rail settled on.
      let following = true
      let followScheduled = false
      let lastKey = ''
      let stableFrames = 0
      let frames = 0
      const follow = (): void => {
        if (!following) return
        const bounds = frameBounds()
        const key =
          bounds === null ? '' : `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
        if (key === lastKey) stableFrames += 1
        else {
          lastKey = key
          stableFrames = 0
          void placePopup(shownId).catch(() => {})
        }
        frames += 1
        if (stableFrames < 3 && frames < 180) requestAnimationFrame(follow)
        else followScheduled = false
      }
      /**
       * Follow the frame until it holds still: called on mount, after every
       * resize and when the window becomes visible again. A call while a follow
       * is already running is ignored, so a drag that fires an observer callback
       * per frame keeps one bounded loop rather than a pile of them. The loop is
       * the tail for motion a transition keeps producing; it is never the only
       * path that places a page, because a window the compositor throttles does
       * not run animation frames at all.
       */
      const followUntilSettled = (): void => {
        if (!following || followScheduled) return
        followScheduled = true
        stableFrames = 0
        frames = 0
        requestAnimationFrame(follow)
      }
      const observer = new ResizeObserver(() => {
        // Place on this change right now   a callback does not wait on an
        // animation frame   and follow whatever the rail's transition keeps
        // moving afterwards.
        void placePopup(shownId).catch(() => {})
        followUntilSettled()
      })
      observer.observe(element)
      const keepUp = (): void => {
        void placePopup(shownId).catch(() => {})
        followUntilSettled()
      }
      const restartFollow = (): void => {
        if (document.visibilityState !== 'visible') return
        // A rail opening while the window was in the background resumes its opening
        // when the window comes back, so the frame has to be followed again.
        void tick().then(() => {
          void placePopup(shownId).catch(() => {})
          followUntilSettled()
        })
      }
      followUntilSettled()
      window.addEventListener('resize', keepUp)
      document.addEventListener('visibilitychange', restartFollow)
      return () => {
        following = false
        observer.disconnect()
        window.removeEventListener('resize', keepUp)
        document.removeEventListener('visibilitychange', restartFollow)
        if (frameElement === element) frameElement = undefined
      }
    }
  }

  /**
   * Attach the popup's page while this panel is the surface allowed to show it,
   * and take it off screen the moment that stops being true.
   *
   * Applied conditionally on purpose: a block published by a modal has to detach
   * the page now and re-attach it when it clears, and only a conditional
   * attachment re-runs on that edge. The id arrives as an argument rather than
   * being read from the prop here, so the teardown always ends the window this
   * attachment put up.
   */
  const manageNativeView = (shownId: string): Attachment<HTMLDivElement> => {
    return () => {
      void tick().then(() => placePopup(shownId).catch(() => {}))
      return () => {
        // Leaving the frame parks the page rather than ending it: main keeps the
        // popup running, so a sign-in switched away from is still there when the
        // user comes back to it.
        browserPopupWindows.hide(shownId)
      }
    }
  }
</script>

{#if popup}
  <!-- Keyed by popup, so switching windows tears one placement down and builds the
       next instead of moving a page that is already on screen. -->
  {#key popupId}
    <!-- `.native-rail-gutter` keeps this frame clear of the rail's resize band: the
         page is a native view composited above the DOM, so a frame reaching the
         band would swallow the drag that adjusts the rail. The frame is sized by
         its own box rather than `w-full`, because a full width plus a left margin
         would run past the rail's edge. -->
    <div
      {@attach attachFrame(popupId)}
      {@attach frameVisible && manageNativeView(popupId)}
      class="native-rail-gutter relative h-full bg-app"
      data-region="browser-popup-window"
    ></div>
  {/key}
{:else}
  <EmptyState
    icon={AppWindow}
    title="No popups right now"
    description="A page's popup window and an extension's own popup both show up here, each as its own tab."
  />
{/if}
