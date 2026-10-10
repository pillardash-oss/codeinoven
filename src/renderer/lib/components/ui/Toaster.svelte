<script lang="ts">
  import { toast } from 'svelte-sonner'
  import { onMount } from 'svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { projectStack, handleToastOverlayInteraction } from '$lib/browser-overlay-bridge'
  import { logRendererError } from '$lib/system/renderer-logger'
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
  function readTypography() {
    const style = getComputedStyle(document.documentElement)
    return {
      fontFamily: style.getPropertyValue('--font-app').trim(),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseFloat(style.fontWeight)
    }
  }
  let typography = $state(readTypography())
  const stack = $derived(projectStack(toast.getActiveToasts(), theme, typography))
  let signature = ''
  let revision = 0
  let retainedIds = new Set<string | number>()
  $effect(() => {
    const activeIds = new Set(stack.toasts.map((entry) => entry.id))
    // The source has no Sonner cards whose unmount would release dismissed state.
    for (const id of retainedIds) if (!activeIds.has(id)) toast.remove(id)
    retainedIds = activeIds
    const next = JSON.stringify(stack)
    if (next === signature) return
    signature = next
    // Empty initial state does not allocate a native renderer.
    if (revision === 0 && !stack.toasts.length) return
    void invoke('browser:setToastOverlay', { ...stack, revision: ++revision }).catch((error) =>
      logRendererError('The native notifications could not be updated', error)
    )
  })
  onMount(() => {
    const offInteractions = subscribe('browser:overlay:event', handleToastOverlayInteraction)
    const observer = new MutationObserver(() => {
      theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      typography = readTypography()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
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
      unsubscribe()
      offInteractions()
      observer.disconnect()
      void invoke('browser:setToastOverlay', null).catch(() => {})
    }
  })
</script>
