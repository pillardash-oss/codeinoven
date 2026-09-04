<script lang="ts">
  import { MessageCircleDashed, MessageSquareDashed } from '@lucide/svelte'

  interface Props {
    onExplain: () => void
    onQuickChat: () => void
  }

  let { onExplain, onQuickChat }: Props = $props()
</script>

<div class="flex flex-wrap items-center gap-1" aria-label="Selection quick chat actions">
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Explain this selection in a temporary read-only chat"
    onclick={onExplain}
  >
    <MessageCircleDashed size={13} aria-hidden="true" />
    Explain
  </button>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Start a temporary read-only quick chat with this selection"
    onclick={onQuickChat}
  >
    <MessageSquareDashed size={13} aria-hidden="true" />
    Quick Chat
  </button>
</div>
