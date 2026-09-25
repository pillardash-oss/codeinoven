<script lang="ts">
  import {
    GitFork,
    MessageCircleDashed,
    MessageCirclePlus,
    MessageSquareDashed
  } from '@lucide/svelte'

  interface Props {
    text: string
    x: number
    y: number
    /** What the selection was taken from, for the toolbar's accessible name.
     *  A conversation quotes a response; a document panel quotes a passage. */
    selectionLabel?: string
    onAdd: () => void
    /** Opening a nested temp chat makes no sense inside one; hidden when omitted. */
    onElaborate?: () => void
    /** Opening a nested temp chat makes no sense inside one; hidden when omitted. */
    onQuickChat?: () => void
    /** Spinning the selection off into a fresh thread is always valid. */
    onNewThread?: () => void
    onClose: () => void
  }

  let {
    text,
    x,
    y,
    selectionLabel = 'response',
    onAdd,
    onElaborate,
    onQuickChat,
    onNewThread,
    onClose
  }: Props = $props()
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
  aria-label={`Actions for the selected ${selectionLabel}: ${text}`}
>
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
    title="Reference this selection in your next message"
    onclick={onAdd}
  >
    <MessageCirclePlus size={13} />
    Comment
  </button>
  {#if onElaborate}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
      title="Explain this selection in a temporary read-only chat"
      onclick={onElaborate}
    >
      <MessageCircleDashed size={13} />
      Explain
    </button>
  {/if}
  {#if onQuickChat}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
      title="Start a temporary read-only chat with this selection"
      onclick={onQuickChat}
    >
      <MessageSquareDashed size={13} />
      Quick chat
    </button>
  {/if}
  {#if onNewThread}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
      title="Start a new thread with this selection already in the composer"
      onclick={onNewThread}
    >
      <GitFork size={13} />
      New thread
    </button>
  {/if}
</div>
