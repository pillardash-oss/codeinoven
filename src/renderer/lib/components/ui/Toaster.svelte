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
    background: color-mix(in srgb, var(--status) 5%, var(--color-surface)) !important;
    border: 1px solid color-mix(in srgb, var(--status) 28%, var(--color-border)) !important;
    color: var(--color-foreground) !important;
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
    left: 10px;
    top: 14px;
    bottom: 14px;
    width: 3px;
    border-radius: 999px;
    background: var(--status);
  }

  /* Icon chip: tinted circle behind the status icon */
  :global([data-sonner-toast] [data-icon]) {
    background: color-mix(in srgb, var(--status) 14%, transparent);
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
  :global(
    [data-sonner-toast][data-type='success'] [data-close-button],
    [data-sonner-toast][data-type='error'] [data-close-button],
    [data-sonner-toast][data-type='warning'] [data-close-button],
    [data-sonner-toast][data-type='info'] [data-close-button]
  ) {
    color: color-mix(in srgb, var(--status) 60%, var(--color-dimmed)) !important;
  }
</style>
