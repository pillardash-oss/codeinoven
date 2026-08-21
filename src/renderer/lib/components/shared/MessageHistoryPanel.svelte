<script lang="ts">
  interface MessageHistoryEntry {
    id: string
    content: string
  }

  interface Props {
    messages: MessageHistoryEntry[]
    onSelect: (id: string, content: string) => void
  }

  let { messages, onSelect }: Props = $props()
</script>

<div class="p-1" role="list" aria-label="Your messages">
  {#each messages as message, index (message.id)}
    <div role="listitem">
      <button
        type="button"
        class="block min-h-11 w-full truncate rounded-lg px-3 py-2.5 text-left text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground active:bg-elevated"
        title={message.content}
        onclick={() => onSelect(message.id, message.content)}
      >
        <span class="mr-1.5 tabular-nums text-dimmed">{index + 1}.</span>
        {message.content}
      </button>
    </div>
  {:else}
    <p class="px-3 py-8 text-center text-sm text-dimmed">No messages yet</p>
  {/each}
</div>
