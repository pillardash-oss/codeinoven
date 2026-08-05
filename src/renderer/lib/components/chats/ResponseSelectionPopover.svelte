<script lang="ts">
  import { MessageCircleDashed, MessageCirclePlus, MessageSquareDashed, X } from '@lucide/svelte'

  interface Props {
    text: string
    x: number
    y: number
    onAdd: () => void
    onElaborate: () => void
    onQuickChat: () => void
    onClose: () => void
  }

  let { text, x, y, onAdd, onElaborate, onQuickChat, onClose }: Props = $props()
</script>

<button
  type="button"
  class="fixed inset-0 z-40 cursor-default"
  aria-label="Close response selection actions"
  onclick={onClose}
></button>

<div
  class="fixed z-50 flex max-w-[calc(100vw-24px)] items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-lg"
  style:left={`${x}px`}
  style:top={`${y}px`}
  role="toolbar"
  aria-label={`Actions for selected response: ${text}`}
>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Reference this selection in your next message"
    onclick={onAdd}
  >
    <MessageCirclePlus size={13} />
    Add to chat
  </button>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Explain this selection in a temporary read-only chat"
    onclick={onElaborate}
  >
    <MessageCircleDashed size={13} />
    Explain
  </button>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Start a temporary read-only chat with this selection"
    onclick={onQuickChat}
  >
    <MessageSquareDashed size={13} />
    Quick chat
  </button>
</div>
