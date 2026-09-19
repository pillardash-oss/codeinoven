<script lang="ts">
  import HistorySidePanel from '$lib/components/shared/HistorySidePanel.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  interface Props {
    /** Dismiss the floating history menu. */
    onClose: () => void
    /** Jump to a message in the conversation. */
    onSelect: (id: string) => void
  }

  let { onClose, onSelect }: Props = $props()
</script>

<button
  class="fixed inset-0 z-30 cursor-default"
  aria-label="Close history"
  title="Close history"
  onclick={onClose}
></button>
<HistorySidePanel
  messages={workspaceState.userMessages}
  busy={workspaceState.historyActions?.busy ?? false}
  forkingId={workspaceState.historyActions?.forkingId ?? null}
  onSelect={(id) => onSelect(id)}
  onFork={(id) => workspaceState.historyActions?.fork(id)}
  onDelete={(id, mode) =>
    workspaceState.historyActions?.requestDelete(
      id,
      workspaceState.userMessages.find((message) => message.id === id)?.content ?? '',
      mode
    )}
  {onClose}
/>
