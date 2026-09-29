<script lang="ts">
  import { toast } from 'svelte-sonner'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { onDestroy, onMount } from 'svelte'
  import {
    TOAST_OVERLAY_ACK_TIMEOUT_MS,
    TOAST_STACK_TOP,
    type ToastOverlayAck
  } from '$shared/toast-overlay'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import {
    handleToastOverlayInteraction,
    projectStack,
    toastCornerBounds
  } from '$lib/toast-overlay-bridge'
  import { logRendererDev, logRendererError } from '$lib/system/renderer-logger'
  import MemoryToastComponent from './MemoryToast.svelte'
  import ToastStack from './ToastStack.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'

  interface ToastAction {
    label: string
    projectId: string
    threadId: string
  }

  /**
   * The app window's toaster, and the switch that moves the stack out of it.
   *
   * The stack itself is svelte-sonner's, in this renderer, and this component is
   * its only owner. The in-app browser's page is a native `WebContentsView`
   * painted above every DOM node of the window, so while a page covers the
   * corner the cards are drawn in, this component hands the stack to the native
   * overlay window (`toast-overlay-window.ts`) and draws nothing itself. The
   * handover is by state, not by call site: every toast in the app keeps calling
   * `toast.*` exactly as it always has.
   *
   * A card in the overlay is only worth drawing while this window can hear it
   * back, because the handlers live here and a card whose button cannot reach
   * them is a card with dead buttons. That is why the reports are subscribed
   * before anything can publish a stack, and why the overlay must confirm what
   * it drew before this window stops drawing.
   */

  let viewportWidth = $state(window.innerWidth)
  let theme = $state<'light' | 'dark'>(
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )

  /** The stack the overlay would draw, projected off the live toast state. */
  let stack = $derived(projectStack(toast.getActiveToasts(), theme))

  /** Whether a native page covers the corner the cards are drawn in. */
  let cornerCovered = $derived(browserVisibility.overlapsNative(toastCornerBounds(viewportWidth)))

  /** True while the overlay window is drawing the stack, which is exactly when
   *  this window must not draw it as well. */
  let overlayLive = $state(false)

  /** True while the page is parked because the overlay cannot be used. */
  let parked = false

  /**
   * The last request this component sent, as a value to compare against.
   *
   * Deliberately not reactive state: the effect below must not re-run because of
   * what it itself last sent, and a stack is republished on every change to any
   * toast, which would otherwise repeat a request that says nothing new. It also
   * keeps the app from asking for an overlay at all until one is needed, which
   * matters because the browser service is only registered once the browser has
   * been opened.
   */
  let sentRequest = 'none'

  /**
   * Whether the overlay's reports can reach this window at all.
   *
   * The reports travel over IPC channels the preload has to expose, and a preload
   * older than this bundle does not expose them: the subscription below then
   * throws as it is made, and without this flag every card drawn in the overlay
   * would have buttons that quietly do nothing. Set here, once, and kept for the
   * session: a window that cannot hear the overlay never uses it, and the toast
   * is drawn by the code path that has always worked.
   */
  let overlayUnavailable = $state(false)

  /** The revision stamped on the next stack this window publishes. */
  let nextRevision = 0

  /** The revision the overlay has been asked for and has not confirmed, or 0. */
  let awaitedRevision = 0

  /** The ids published under `awaitedRevision`, for the dev diagnostic below. */
  let awaitedIds: Array<number | string> = []

  let ackTimer: ReturnType<typeof setTimeout> | undefined

  function stopAckWatch(): void {
    if (ackTimer !== undefined) clearTimeout(ackTimer)
    ackTimer = undefined
    awaitedRevision = 0
    awaitedIds = []
  }

  /**
   * Stop using the overlay for the rest of the session, and draw the cards here.
   *
   * Every reason the overlay cannot serve the stack ends the same way: the cards
   * belong in this window's own toaster, and the page steps aside while they are
   * up so they are not painted under it. Losing the overlay is logged rather
   * than shown, because the toast itself still works; what it costs is the page
   * blinking for as long as a card is on screen, which the log line is there to
   * explain when someone notices it.
   */
  function abandonOverlay(reason: string): void {
    stopAckWatch()
    if (overlayUnavailable) return
    overlayUnavailable = true
    overlayLive = false
    logRendererError(
      `The native toast overlay was abandoned: ${reason}. Toasts are drawn in the app window again, and a browser page that covers their corner is parked for as long as they are on screen.`
    )
    void invoke('browser:setToastOverlay', null).catch(() => {})
  }

  /**
   * Wait for the overlay to confirm the revision it was given.
   *
   * The deadline belongs to the first stack that went unanswered, not to the
   * newest one: a window that never confirms would otherwise keep its watch
   * moving every time a card arrived. Any confirmation clears it, because a
   * revision only stays unconfirmed while the overlay is silent.
   */
  function armAckWatch(revision: number, ids: Array<number | string>): void {
    awaitedRevision = revision
    awaitedIds = ids
    if (ackTimer !== undefined) return
    ackTimer = setTimeout(() => {
      ackTimer = undefined
      if (awaitedRevision === 0) return
      abandonOverlay('it never confirmed the cards it was given')
    }, TOAST_OVERLAY_ACK_TIMEOUT_MS)
  }

  /** The overlay drew the revision this window published, so the path works. */
  function noteOverlayDrawn(ack: ToastOverlayAck): void {
    if (ack.revision !== awaitedRevision) return
    if (import.meta.env.DEV && ack.drawn.length !== awaitedIds.length) {
      logRendererDev(
        `The toast overlay drew ${ack.drawn.length} of the ${awaitedIds.length} cards it was given`
      )
    }
    stopAckWatch()
  }

  /**
   * The overlay's reports, subscribed during setup rather than in `onMount`.
   *
   * Two reasons, and both are load-bearing. The publish effect below must never
   * be able to hand the stack to an overlay this window cannot hear, so the
   * answer has to be known before that effect's first pass; and a subscription
   * that throws inside a lifecycle callback would take the rest of that callback
   * with it, which is how a channel this preload does not know once left every
   * toast in the app without its handler.
   */
  const overlayReports: Array<() => void> = (() => {
    try {
      return [
        subscribe('browser:toastOverlay:event', (report) => handleToastOverlayInteraction(report)),
        subscribe('browser:toastOverlay:drawn', (ack) => noteOverlayDrawn(ack))
      ]
    } catch (error) {
      overlayUnavailable = true
      logRendererError(
        'This window cannot hear the native toast overlay, so toasts stay in the app window.',
        error
      )
      return []
    }
  })()

  async function parkForFallback(park: boolean): Promise<void> {
    if (park === parked) return
    parked = park
    await invoke('browser:setToastVisible', park).catch(() => {})
  }

  /**
   * Point the overlay at the stack, or take it down.
   *
   * Three outcomes, in the order they are tried:
   *
   *   - no page covers the corner: the app window draws the cards, as always,
   *     and the overlay is released so a browsing session that never covers the
   *     corner never pays for a second renderer;
   *   - a page covers it and the overlay draws and confirms them: the overlay
   *     draws them;
   *   - the overlay cannot serve them for any reason (this window cannot hear it,
   *     its window could not be created, its request was refused, or it never
   *     confirmed): the cards stay in this window's toaster and the page steps
   *     aside for as long as they are up, because a page that blinks is far
   *     better than a toast that is either invisible behind it or drawn with
   *     buttons that do nothing.
   */
  $effect(() => {
    if (overlayUnavailable) {
      overlayLive = false
      void parkForFallback(cornerCovered && stack.toasts.length > 0)
      return
    }
    const request = cornerCovered ? stack : null
    const signature = request === null ? 'release' : JSON.stringify(request)
    if (signature === sentRequest) return
    sentRequest = signature
    // The revision is stamped here, not on the stack itself: the signature above
    // compares the stack, and one that changed every pass would make every pass
    // look new and republish a stack that says nothing different.
    const revision = (nextRevision += 1)
    if (request === null || request.toasts.length === 0) {
      stopAckWatch()
      overlayLive = false
      void parkForFallback(false)
      void invoke(
        'browser:setToastOverlay',
        request === null ? null : { ...request, revision }
      ).catch(() => {})
      return
    }
    const ids = request.toasts.map((entry) => entry.id)
    let cancelled = false
    void invoke('browser:setToastOverlay', { ...request, revision })
      .then((available) => {
        if (cancelled) return
        overlayLive = available
        void parkForFallback(!available)
        if (available) armAckWatch(revision, ids)
        else abandonOverlay('its window could not be created')
      })
      .catch(() => {
        if (cancelled) return
        abandonOverlay('a request to draw the cards was refused')
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const observer = new MutationObserver(() => {
      theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  })

  onMount(() => {
    const trackViewport = (): void => {
      viewportWidth = window.innerWidth
    }
    window.addEventListener('resize', trackViewport)
    const unsubscribe = subscribe('app:toast', (event) => {
      const payload = event as
        | {
            message?: string
            type?: 'error' | 'info'
            action?: ToastAction
            details?: string
            projectId?: string
            threadId?: string
          }
        | undefined
      const message = payload?.message
      if (!message) return
      if (payload?.action) {
        void memoryProposalState.refreshCurrent()
        toast.custom(MemoryToastComponent, {
          duration: 10_000,
          componentProps: {
            message,
            projectId: payload.action.projectId,
            threadId: payload.action.threadId
          }
        })
      } else if (payload?.type === 'info') {
        toast.info(message, { closeButton: true })
      } else {
        reportErrorWithDetails(message, {
          details: payload.details,
          thread:
            payload.projectId && payload.threadId
              ? { projectId: payload.projectId, threadId: payload.threadId }
              : undefined
        })
      }
    })
    return () => {
      window.removeEventListener('resize', trackViewport)
      unsubscribe()
    }
  })

  onDestroy(() => {
    for (const off of overlayReports) off()
    stopAckWatch()
  })
</script>

{#if !overlayLive}
  <ToastStack {theme} offsetTop={TOAST_STACK_TOP} />
{/if}
