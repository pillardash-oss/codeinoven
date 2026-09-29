<script lang="ts">
  import { Toaster as Sonner, toast } from 'svelte-sonner'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { onMount, tick } from 'svelte'
  import { CheckCircle2, AlertTriangle, XCircle, Info } from '@lucide/svelte'
  import MemoryToastComponent from './MemoryToast.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { resolveToastLane } from '$lib/stores/toast-lane'
  import { TOAST_LAYER_SELECTOR } from '$lib/toast-layer'

  interface ToastAction {
    label: string
    projectId: string
    threadId: string
  }

  /**
   * The lane this toaster renders in, and where that lane sits.
   *
   * The in-app browser's page is a native `WebContentsView` painted above every
   * DOM node of the window, so a toast cannot draw over it and the toaster has to
   * be somewhere the page is not. `toast-lane.ts` owns that decision; the window's
   * width is tracked here because it is an input the store cannot read for itself.
   */
  const POSITION_BY_LANE = {
    right: 'top-right',
    'narrow-right': 'top-right',
    left: 'top-left',
    'narrow-left': 'top-left',
    compact: 'top-center'
  } as const

  let viewportWidth = $state(window.innerWidth)
  let placement = $derived(resolveToastLane(viewportWidth, browserVisibility.onScreenFrames))
  let lanePosition = $derived(POSITION_BY_LANE[placement.lane])

  let theme = $state<'light' | 'dark'>(
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )

  let toastActive = $derived(toast.getActiveToasts().length > 0)

  /**
   * How many cards the toaster keeps on screen at once.
   *
   * The compact lane is one line inside the 48px header, so a second card would
   * start below it and end up behind the page. One card at a time is the honest
   * answer there; the narrower lanes and the normal one have room for the default
   * stack.
   */
  let visibleToasts = $derived(placement.lane === 'compact' ? 1 : undefined)

  /**
   * The width the narrow and compact lanes render at, published to CSS.
   *
   * It goes on the document element rather than on the toaster because the width
   * has to reach a rule that can beat svelte-sonner's own inline `--width`, and
   * the library writes its inline custom properties on the same element the lane
   * attribute sits on.
   */
  $effect(() => {
    document.documentElement.style.setProperty('--toast-lane-width', `${placement.width}px`)
  })

  /**
   * Park the browser page for the one case the lane cannot serve.
   *
   * A lane is picked before a card is measured, so it reserves room for the tallest
   * card this app builds rather than the card in hand. This is the check that makes
   * that an assumption instead of a promise: once the cards are laid out their real
   * rectangle is measured against the pages actually on screen, and a toast that
   * still lands under one takes the old route rather than being invisible behind
   * it. It should not fire: the compact lane lives in the application header, the
   * one band no page can reach, because every page is placed inside `main` below
   * it.
   */
  let laneParked = false

  async function parkIfCovered(): Promise<void> {
    await tick()
    const layer = document.querySelector(TOAST_LAYER_SELECTOR)
    const rect = layer?.getBoundingClientRect()
    if (!rect || rect.width < 1 || rect.height < 1) return
    // Shrink by a couple of pixels first, so a rounded corner is not read as a page
    // sitting on top of the toast.
    const covered = browserVisibility.overlapsNative({
      x: rect.x + 2,
      y: rect.y + 2,
      width: Math.max(1, rect.width - 4),
      height: Math.max(1, rect.height - 4)
    })
    if (covered === laneParked) return
    laneParked = covered
    await invoke('browser:setToastVisible', covered).catch(() => {})
  }

  $effect(() => {
    // Reading the frames here is what re-runs the check when the layout under the
    // page changes and the lane moves with it.
    const frames = browserVisibility.onScreenFrames
    if (!toastActive) {
      // The restore waits out svelte-sonner's ~200ms exit animation, so a fading
      // toast is never clipped by the page coming back.
      const restoreTimer = setTimeout(() => {
        laneParked = false
        void invoke('browser:setToastVisible', false).catch(() => {})
      }, 300)
      return () => clearTimeout(restoreTimer)
    }
    if (frames.length === 0) return
    void parkIfCovered()
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
</script>

{#snippet successIcon()}
  <CheckCircle2 size={15} stroke-width={2.25} />
{/snippet}

{#snippet warningIcon()}
  <AlertTriangle size={15} stroke-width={2.25} />
{/snippet}

{#snippet errorIcon()}
  <XCircle size={15} stroke-width={2.25} />
{/snippet}

{#snippet infoIcon()}
  <Info size={15} stroke-width={2.25} />
{/snippet}

<div data-toast-lane={placement.lane}>
  <Sonner
    position={lanePosition}
    {theme}
    closeButton
    pauseWhenPageIsHidden
    {visibleToasts}
    offset={{ top: '56px' }}
    {successIcon}
    {warningIcon}
    {errorIcon}
    {infoIcon}
    toastOptions={{
      classes: {
        toast: 'group toast shadow-lg rounded-lg font-[inherit]',
        title: 'text-[0.8125rem] font-semibold tracking-tight',
        description: 'group-[.toast]:text-muted text-xs',
        actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-on-primary',
        cancelButton: 'group-[.toast]:bg-elevated group-[.toast]:text-muted'
      }
    }}
  />
</div>

<style>
  :global([data-close-button]) {
    top: 6px !important;
    right: 6px !important;
    left: auto !important;
    transform: none !important;
  }

  :global([data-close-button] > *) {
    pointer-events: none;
  }

  /* ─── Layout: [icon] [title] header row, [description] full-width row,
     [buttons] sharing the bottom row. Selectors match svelte-sonner's
     internal [data-styled='true'] specificity and use !important because
     the library's own stylesheet competes in the cascade. ─────────────── */
  :global([data-sonner-toast]) {
    flex-wrap: wrap !important;
    align-items: flex-start !important;
    gap: 6px !important;
  }

  /* Dissolve the content wrapper so title and description become direct
     flex items and can sit on separate rows */
  :global([data-sonner-toast][data-styled='true'] [data-content]) {
    display: contents !important;
  }

  :global([data-sonner-toast][data-styled='true'] [data-title]) {
    flex: 1 1 0 !important;
    min-width: 0 !important;
  }

  :global([data-sonner-toast][data-styled='true'] [data-description]) {
    flex: 1 1 100% !important;
  }

  :global([data-sonner-toast][data-styled='true'] [data-button]) {
    /* 100% basis (not 0) so the button ALWAYS wraps to its own bottom row,
       even when the toast has no description. With basis 0 an action button
       and a title fit side by side on one row, which is exactly the bug that
       hit error toasts (title + Copy, no description) while thread toasts
       (title + description + action) wrapped correctly. One rule, one
       behaviour, every status. */
    flex: 1 1 100% !important;
    margin-top: 4px !important;
    justify-content: center !important;
  }

  /* ─── Normal toasts ─────────────────────────────────────────────────────── */
  :global([data-sonner-toaster][data-sonner-theme='light']) {
    --normal-bg: var(--color-surface) !important;
    --normal-border: var(--color-border) !important;
    --normal-text: var(--color-foreground) !important;
  }

  :global([data-sonner-toaster][data-sonner-theme='dark']) {
    --normal-bg: var(--color-surface) !important;
    --normal-border: var(--color-border) !important;
    --normal-text: var(--color-foreground) !important;
  }

  /* ─── Branded status toasts ───────────────────────────────────────────────
     Obsidian / Ivory / Auric system: each status toast keeps the ivory
     surface but carries a status tint in the background wash, the hairline
     border, the icon chip and a slim accent bar on the left edge. */
  :global([data-sonner-toast][data-type='success']),
  :global([data-sonner-toast][data-type='error']),
  :global([data-sonner-toast][data-type='warning']),
  :global([data-sonner-toast][data-type='info']) {
    position: relative;
  }

  :global([data-sonner-toast][data-type='success']) {
    --status: var(--color-success);
  }

  :global([data-sonner-toast][data-type='error']) {
    --status: var(--color-danger);
  }

  :global([data-sonner-toast][data-type='warning']) {
    --status: var(--color-warning);
  }

  :global([data-sonner-toast][data-type='info']) {
    --status: var(--color-info);
  }

  :global(
    [data-sonner-toast][data-type='success'],
    [data-sonner-toast][data-type='error'],
    [data-sonner-toast][data-type='warning'],
    [data-sonner-toast][data-type='info']
  ) {
    background:
      linear-gradient(
        to right,
        color-mix(in srgb, var(--status) 16%, transparent),
        color-mix(in srgb, var(--status) 7%, transparent) 60%,
        color-mix(in srgb, var(--status) 4%, transparent)
      ),
      var(--color-surface) !important;
    border: 1px solid color-mix(in srgb, var(--status) 55%, var(--color-border)) !important;
    /* Real border instead of a ::before bar   it can never detach or escape
       the toast during drag, dismissal or scale transitions. */
    border-left: 3px solid var(--status) !important;
    box-shadow:
      0 4px 16px -4px color-mix(in srgb, var(--status) 25%, transparent),
      0 2px 8px -2px rgba(0, 0, 0, 0.12) !important;
    color: var(--color-foreground) !important;
  }

  /* Status-colored title   the colour reads before the words do */
  :global(
    [data-sonner-toast][data-type='success'] [data-title],
    [data-sonner-toast][data-type='error'] [data-title],
    [data-sonner-toast][data-type='warning'] [data-title],
    [data-sonner-toast][data-type='info'] [data-title]
  ) {
    color: color-mix(in srgb, var(--status) 78%, var(--color-foreground)) !important;
  }

  /* Status-colored close button for instant recognition */
  :global(
    [data-sonner-toast][data-type='success'] [data-close-button],
    [data-sonner-toast][data-type='error'] [data-close-button],
    [data-sonner-toast][data-type='warning'] [data-close-button],
    [data-sonner-toast][data-type='info'] [data-close-button]
  ) {
    color: color-mix(in srgb, var(--status) 70%, var(--color-dimmed)) !important;
    background: color-mix(in srgb, var(--status) 10%, transparent) !important;
    border-radius: 999px !important;
    width: 1.25rem !important;
    height: 1.25rem !important;
    display: grid !important;
    place-items: center !important;
  }

  /* Icon chip: tinted circle behind the status icon */
  :global([data-sonner-toast] [data-icon]) {
    background: color-mix(in srgb, var(--status) 22%, transparent);
    color: var(--status);
    border-radius: 999px;
    width: 1.75rem;
    height: 1.75rem;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    align-self: flex-start;
    margin-top: 1px;
  }

  /* Close button inherits the status colour subtly */
</style>
