<script lang="ts">
  import { GitFork, Loader2, Shredder, Trash2, X } from '@lucide/svelte'

  export type DeleteMode = 'down' | 'single' | 'up'

  interface HistoryEntry {
    id: string
    content: string
    /** First few work-trace snippets of the turn that follows this message. */
    tracePreview?: string[]
  }

  interface Props {
    messages: HistoryEntry[]
    /** A turn is running — destructive actions are disabled. */
    busy?: boolean
    /** Id currently being forked. */
    forkingId?: string | null
    onSelect: (id: string) => void
    onFork: (id: string) => void
    onDelete: (id: string, mode: DeleteMode) => void
    onClose: () => void
  }

  let {
    messages,
    busy = false,
    forkingId = null,
    onSelect,
    onFork,
    onDelete,
    onClose
  }: Props = $props()
</script>

<!--
  Full-height history side panel docked left of the context dock rail. User
  messages form the trunk; the work trace of each turn hangs beneath its
  message as children. Fork and the three delete scopes live here — the
  conversation screen itself is untouched.
-->
<section
  class="fixed top-2 bottom-2 right-13 z-40 flex w-80 flex-col overflow-hidden border bg-surface shadow-lg"
  aria-label="Message history"
>
  <header class="flex items-center justify-between border-b px-3 py-2">
    <p class="text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed">
      Your messages
      {#if messages.length > 0}
        <span class="ml-1 tabular-nums tracking-normal normal-case">({messages.length})</span>
      {/if}
    </p>
    <button
      type="button"
      class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Close history panel"
      title="Close history panel"
      onclick={onClose}
    >
      <X size={14} />
    </button>
  </header>
  <div class="min-h-0 flex-1 overflow-y-auto p-1" role="list" aria-label="Your messages">
    {#each messages as message, index (message.id)}
      <div role="listitem" class="group/msg">
        <div
          class="flex items-center gap-0.5 rounded-lg pr-1 transition-colors group-hover/msg:bg-elevated"
        >
          <button
            type="button"
            class="min-h-9 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-sm text-muted transition-colors group-hover/msg:text-foreground"
            title={message.content}
            onclick={() => onSelect(message.id)}
          >
            <span class="mr-1.5 tabular-nums text-dimmed">{index + 1}.</span>
            {message.content}
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-1 text-dimmed opacity-0 transition-all group-hover/msg:opacity-100 hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Fork the conversation from this message"
            title="Fork from this message"
            disabled={busy || forkingId !== null}
            onclick={() => onFork(message.id)}
          >
            {#if forkingId === message.id}
              <Loader2 size={13} class="animate-spin" />
            {:else}
              <GitFork size={13} />
            {/if}
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-1 text-dimmed opacity-0 transition-all group-hover/msg:opacity-100 hover:bg-elevated hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Delete this message and everything before it"
            title="Delete up (this message and everything before)"
            disabled={busy}
            onclick={() => onDelete(message.id, 'up')}
          >
            <Shredder size={13} />
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-1 text-dimmed opacity-0 transition-all group-hover/msg:opacity-100 hover:bg-elevated hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Delete just this message and its work trace"
            title="Delete just this message"
            disabled={busy}
            onclick={() => onDelete(message.id, 'single')}
          >
            <Trash2 size={13} />
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-1 text-dimmed opacity-0 transition-all group-hover/msg:opacity-100 hover:bg-elevated hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Delete this message and everything after it"
            title="Delete down (this message and everything after)"
            disabled={busy}
            onclick={() => onDelete(message.id, 'down')}
          >
            <Shredder size={13} class="rotate-180" />
          </button>
        </div>
        {#if message.tracePreview && message.tracePreview.length > 0}
          <div class="ml-5 border-l pl-3">
            {#each message.tracePreview as snippet, snippetIndex (snippetIndex)}
              <p class="truncate py-0.5 text-xs text-dimmed" title={snippet}>{snippet}</p>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <p class="px-3 py-8 text-center text-sm text-dimmed">No messages yet</p>
    {/each}
  </div>
</section>
