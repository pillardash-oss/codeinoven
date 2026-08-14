<script lang="ts">
  import type { Snippet } from 'svelte'
  import FileDiffView from './FileDiffView.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { TurnCheckpointFileDiff } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
    checkpointId: string
    path: string
    trigger: Snippet
    /** Caps the height of the scrollable diff body. */
    maxHeight?: string
    /** Width of the popover. */
    width?: string
    /** Extra classes for the hover wrapper element. */
    class?: string
  }

  let {
    projectId,
    threadId,
    checkpointId,
    path,
    trigger,
    maxHeight = '18rem',
    width = '460px',
    class: className = ''
  }: Props = $props()

  const SHOW_DELAY_MS = 350
  const HIDE_DELAY_MS = 200
  const GAP_PX = 10

  let anchor = $state<HTMLElement | null>(null)
  let open = $state(false)
  let position = $state<{ top: number; left: number }>({ top: 0, left: 0 })
  let diff = $state<TurnCheckpointFileDiff | null>(null)
  let loading = $state(false)
  let error = $state('')
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  async function ensureDiff(): Promise<void> {
    if (diff || loading) return
    loading = true
    error = ''
    try {
      diff = await invoke('checkpoint:diff', projectId, threadId, checkpointId, path)
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'The diff could not be loaded'
    } finally {
      loading = false
    }
  }

  function place(): void {
    const rect = anchor?.getBoundingClientRect()
    if (!rect) return
    const estimateHeight = 360
    const estimateWidth = 460
    let top = rect.top + rect.height / 2 - estimateHeight / 2
    let left = rect.right + GAP_PX
    const maxLeft = window.innerWidth - estimateWidth - 8
    const maxTop = window.innerHeight - estimateHeight - 8
    if (left > maxLeft) left = Math.max(8, rect.left - estimateWidth - GAP_PX)
    top = Math.max(8, Math.min(maxTop, top))
    position = { top, left }
  }

  function scheduleShow(): void {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (showTimer) return
    showTimer = setTimeout(() => {
      showTimer = null
      place()
      open = true
      void ensureDiff()
    }, SHOW_DELAY_MS)
  }

  function scheduleHide(): void {
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
    if (hideTimer) return
    hideTimer = setTimeout(() => {
      hideTimer = null
      open = false
    }, HIDE_DELAY_MS)
  }

  function cancelHide(): void {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function closeOnScroll(event: Event): void {
    const target = event.target as Node | null
    if (target && anchor?.contains(target)) return
    open = false
  }

  function closeOnKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') open = false
  }

  $effect(() => {
    if (!open) return
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('keydown', closeOnKeydown)
    return () => {
      window.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('keydown', closeOnKeydown)
    }
  })
</script>

<span
  bind:this={anchor}
  role="group"
  class="inline-flex {className}"
  onpointerenter={scheduleShow}
  onpointerleave={scheduleHide}
  onfocusin={scheduleShow}
  onfocusout={scheduleHide}
>
  {@render trigger()}
</span>

{#if open}
  <div
    role="dialog"
    aria-label={`Diff preview for ${path}`}
    tabindex="-1"
    class="fixed z-50 overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
    style="top: {position.top}px; left: {position.left}px; width: {width};"
    onpointerenter={cancelHide}
    onpointerleave={scheduleHide}
  >
    <div class="max-w-full overflow-auto py-1" style="max-height: {maxHeight};">
      {#if loading}
        <p class="px-3 py-4 text-[10px] text-dimmed">Loading diff…</p>
      {:else if error}
        <p class="px-3 py-4 text-[10px] text-danger" role="alert">{error}</p>
      {:else if diff}
        <FileDiffView {diff} />
      {/if}
    </div>
  </div>
{/if}
