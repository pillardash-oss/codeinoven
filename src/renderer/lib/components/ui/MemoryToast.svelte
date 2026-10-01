<script lang="ts">
  import { BrainCircuit } from '@lucide/svelte'
  import { openMemoryProposal } from '$lib/stores/memory-proposal-open'
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

<div class="flex items-start gap-3 rounded-xl border bg-surface p-3 text-foreground shadow-xl">
  <div class="mt-0.5 shrink-0 text-primary">
    <BrainCircuit size={18} />
  </div>
  <div class="min-w-0 flex-1">
    <p class="text-sm leading-relaxed text-foreground">{message}</p>
    <button
      class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      type="button"
      onclick={view}
    >
      <BrainCircuit size={12} />
      Review Memory
    </button>
  </div>
</div>
