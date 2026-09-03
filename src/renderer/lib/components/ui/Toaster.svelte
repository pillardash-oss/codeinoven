<script lang="ts">
  import { Toaster as Sonner, toast } from 'svelte-sonner'
  import { subscribe } from '$lib/ipc.svelte'
  import { onMount } from 'svelte'
  import { CheckCircle2, AlertTriangle, XCircle, Info } from '@lucide/svelte'
  import MemoryToastComponent from './MemoryToast.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'

  interface ToastAction {
    label: string
    projectId: string
    threadId: string
  }

  let theme = $state<'light' | 'dark'>(
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )

  $effect(() => {
    const observer = new MutationObserver(() => {
      theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  })

  onMount(() => {
    return subscribe('app:toast', (event) => {
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

<Sonner
  position="top-right"
  {theme}
  closeButton
  pauseWhenPageIsHidden
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

  /* ─── Action buttons: full-width row below the content ──────────────────── */
  :global([data-sonner-toast]) {
    flex-wrap: wrap;
  }

  :global([data-sonner-toast] [data-content]) {
    flex: 1 1 0;
    min-width: 0;
  }

  :global([data-sonner-toast] [data-button]) {
    flex: 1 1 100%;
    width: 100%;
    margin-top: 10px;
    justify-content: center;
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
    --status: transparent;
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
    box-shadow:
      0 4px 16px -4px color-mix(in srgb, var(--status) 25%, transparent),
      0 2px 8px -2px rgba(0, 0, 0, 0.12) !important;
    color: var(--color-foreground) !important;
  }

  /* Status-colored title — the colour reads before the words do */
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

  /* Slim accent bar on the left edge */
  :global(
    [data-sonner-toast][data-type='success']::before,
    [data-sonner-toast][data-type='error']::before,
    [data-sonner-toast][data-type='warning']::before,
    [data-sonner-toast][data-type='info']::before
  ) {
    content: '';
    position: absolute;
    left: 5px;
    top: 14px;
    bottom: 14px;
    width: 4px;
    border-radius: 999px;
    background: var(--status);
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
