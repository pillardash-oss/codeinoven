<script lang="ts">
  import CioMemory from '@pdslng/cio-icon/CioMemory.svelte'
  import { openMemoryProposal } from '$lib/stores/memory-proposal-open'
  import { preloadThreadById } from '$lib/stores/thread-preload'
  interface Props {
    message: string
    projectId: string
    threadId: string
    closeToast?: () => void
  }

  let { message, projectId, threadId, closeToast }: Props = $props()

  let opening = $state(false)

  /**
   * Review opens the thread the proposal came from and docks the memory panel on
   * it. The flow itself lives in the store, because the same toast is drawn by
   * the native overlay over a browser page, where only this renderer can run it.
   */
  async function view(): Promise<void> {
    if (opening) return
    opening = true
    try {
      await openMemoryProposal(projectId, threadId)
    } finally {
      closeToast?.()
    }
  }
</script>

<div
  class="flex items-start gap-3 border bg-surface p-3 text-foreground shadow-xl"
  role="status"
  onmouseenter={() => preloadThreadById(projectId, threadId)}
>
  <div class="mt-0.5 shrink-0 text-primary">
    <CioMemory size={18} />
  </div>
  <div class="min-w-0 flex-1">
    <p class="text-sm leading-relaxed text-foreground">{message}</p>
    <button
      class="mt-2 inline-flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      type="button"
      onclick={view}
    >
      <CioMemory size={12} />
      Review Memory
    </button>
  </div>
</div>
