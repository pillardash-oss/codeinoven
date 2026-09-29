<script lang="ts">
  import { toast } from 'svelte-sonner'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { onMount } from 'svelte'
  import { TOAST_STACK_TOP, type ToastOverlayRequest } from '$shared/toast-overlay'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import {
    handleToastOverlayInteraction,
    projectStack,
    toastCornerBounds
  } from '$lib/toast-overlay-bridge'
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

  /** True while the page is parked because the overlay could not be created. */
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
   *   - a page covers it and the overlay is available: the overlay draws them;
   *   - a page covers it and the overlay could not be created: the page steps
   *     aside, because a toast hidden behind a page is worse than a page that
   *     blinks for as long as the toast lasts.
   */
  $effect(() => {
    const request: ToastOverlayRequest = cornerCovered ? stack : null
    const signature = request === null ? 'release' : JSON.stringify(request)
    if (signature === sentRequest) return
    sentRequest = signature
    if (request === null || request.toasts.length === 0) {
      overlayLive = false
      void parkForFallback(false)
      void invoke('browser:setToastOverlay', request).catch(() => {})
      return
    }
    let cancelled = false
    void invoke('browser:setToastOverlay', request)
      .then((available) => {
        if (cancelled) return
        overlayLive = available
        void parkForFallback(!available)
      })
      .catch(() => {
        if (!cancelled) overlayLive = false
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
    // A card the overlay drew is still this renderer's toast: the overlay reports
    // what the user did and the handler the toast carries runs here.
    const unsubscribeOverlay = subscribe('browser:toastOverlay:event', (report) =>
      handleToastOverlayInteraction(report)
    )
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
      unsubscribeOverlay()
    }
  })
</script>

{#if !overlayLive}
  <ToastStack {theme} offsetTop={TOAST_STACK_TOP} />
{/if}
