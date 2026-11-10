<script lang="ts">
  import CioMonogram from '$lib/components/icons/cio/CioMonogram.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import type { Assistant } from '$shared/types'

  /**
   * Don, pinned as a centred square at the top of the assistant list.
   *
   * Don is not a row like the others: it is the one thread every conversation can
   * reach without opening the assistant view, so it holds a slot of its own above
   * the list. The square is the app's own rule for a control that is a place
   * rather than an item, and it is centred so the orchestrator reads as the door
   * the list stands under.
   *
   * It wears the app's own monogram on the brand plate, the black ground and ink
   * of the app icon, in both themes: Don is the app's front door, so its tile is
   * the app's own treatment rather than an assistant's accent, and it reads the
   * same at night as it does by day. The plate is never draggable and never
   * carries a menu that could rename, delete or repin it.
   */
  interface Props {
    assistant: Assistant | null
    /** Don's one thread, absent only while the bootstrap has not seeded it yet. */
    threadId: string | null
    selected: boolean
    iconUrl?: string | null
    /** Whether Don can run at all: it needs instructions and a model like any assistant. */
    ready: boolean
    /**
     * Whether Don's conversation holds an answer nobody has read yet.
     *
     * A delegation reports into the group rather than into the run's own row, so
     * this tile is the one place that says an answer came back.
     */
    unread: boolean
    onOpen: () => void
  }

  let { assistant, threadId, selected, iconUrl = null, ready, unread, onOpen }: Props = $props()

  const name = $derived(assistant?.name?.trim() || 'Don')
  const title = $derived(
    ready ? `Open ${name}, your orchestrator` : `${name} needs a model before it can take work`
  )
</script>

<div class="flex justify-center px-3 pt-3.5 pb-1">
  <button
    type="button"
    class="group flex flex-col items-center gap-2 outline-none"
    {title}
    aria-label={title}
    aria-current={selected ? 'page' : undefined}
    disabled={threadId === null}
    onclick={onOpen}
  >
    <span
      class="flex size-24 items-center justify-center bg-brand-plate transition-shadow {selected
        ? 'ring-2 ring-accent'
        : 'ring-1 ring-border group-hover:ring-border-strong'}"
    >
      {#if iconUrl}
        <img src={iconUrl} alt="" aria-hidden="true" class="size-14 object-contain" />
      {:else}
        <CioMonogram size={56} class="text-brand-ink" />
      {/if}
    </span>
    <span class="flex items-center gap-1 text-sm font-medium text-foreground">
      {#if unread && !selected}
        <StatusBadge stage="unread" title={`${name} has an answer you have not read`} />
      {/if}
      {name}
      {#if !ready}
        <CioAttention
          size={12}
          class="text-warning"
          title={`${name} has no model yet`}
          aria-label={`${name} has no model yet`}
        />
      {/if}
    </span>
  </button>
</div>
