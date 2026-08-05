<script lang="ts">
  import { BrainCircuit } from '@lucide/svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  interface Props {
    message: string
    projectId: string
    threadId: string
    closeToast?: () => void
  }

  let { message, projectId, threadId, closeToast }: Props = $props()

  function view(): void {
    contextSidebarState.openMemory(projectId, threadId, 'proposed')
    closeToast?.()
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
