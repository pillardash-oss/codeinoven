<script lang="ts">
  import { Toaster as Sonner, toast } from 'svelte-sonner'
  import { subscribe } from '$lib/ipc.svelte'
  import { onMount } from 'svelte'
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

<Sonner
  position="top-right"
  {theme}
  closeButton
  richColors
  pauseWhenPageIsHidden
  offset={{ top: '56px' }}
  toastOptions={{
    classes: {
      toast: 'group toast border shadow-lg rounded-lg',
      description: 'group-[.toast]:text-muted',
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

  :global([data-sonner-toaster][data-sonner-theme='light']) {
    --normal-bg: var(--color-surface) !important;
    --normal-border: var(--color-border) !important;
    --normal-text: var(--color-foreground) !important;
    --success-bg: color-mix(in srgb, var(--color-success) 12%, var(--color-surface)) !important;
    --success-border: var(--color-success) !important;
    --success-text: var(--color-foreground) !important;
    --error-bg: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface)) !important;
    --error-border: var(--color-danger) !important;
    --error-text: var(--color-foreground) !important;
    --info-bg: color-mix(in srgb, var(--color-info) 12%, var(--color-surface)) !important;
    --info-border: var(--color-info) !important;
    --info-text: var(--color-foreground) !important;
    --warning-bg: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface)) !important;
    --warning-border: var(--color-warning) !important;
    --warning-text: var(--color-foreground) !important;
  }

  :global([data-sonner-toaster][data-sonner-theme='dark']) {
    --normal-bg: var(--color-surface) !important;
    --normal-border: var(--color-border) !important;
    --normal-text: var(--color-foreground) !important;
    --success-bg: color-mix(in srgb, var(--color-success) 15%, var(--color-app)) !important;
    --success-border: color-mix(in srgb, var(--color-success) 35%, var(--color-border)) !important;
    --success-text: color-mix(
      in srgb,
      var(--color-success) 55%,
      var(--color-foreground)
    ) !important;
    --error-bg: color-mix(in srgb, var(--color-danger) 15%, var(--color-app)) !important;
    --error-border: color-mix(in srgb, var(--color-danger) 35%, var(--color-border)) !important;
    --error-text: color-mix(in srgb, var(--color-danger) 55%, var(--color-foreground)) !important;
    --info-bg: color-mix(in srgb, var(--color-info) 12%, var(--color-app)) !important;
    --info-border: color-mix(in srgb, var(--color-info) 35%, var(--color-border)) !important;
    --info-text: color-mix(in srgb, var(--color-info) 55%, var(--color-foreground)) !important;
    --warning-bg: color-mix(in srgb, var(--color-warning) 12%, var(--color-app)) !important;
    --warning-border: color-mix(in srgb, var(--color-warning) 35%, var(--color-border)) !important;
    --warning-text: color-mix(
      in srgb,
      var(--color-warning) 55%,
      var(--color-foreground)
    ) !important;
  }
</style>
