<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
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
   * It wears the assistant mark itself   the face, not one of the job variants
   *   because Don is the assistant, and the mark is what makes that true at a
   * glance. The mark is ink on the brand plate, the black ground and ink of the
   * app icon, in light and dark alike, so the tile does not change colour with
   * the appearance. The tile is never draggable and never carries a menu that
   * could rename, delete or repin it.
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
    ready ? `Open ${name}'s group chat` : `${name} needs a model before it can take work`
  )
</script>

<div class="flex justify-center px-3 pt-3.5 pb-1">
  <button
    type="button"
    class="group flex cursor-pointer flex-col items-center gap-2 outline-none disabled:cursor-default"
    {title}
    aria-label={title}
    aria-current={selected ? 'page' : undefined}
    disabled={threadId === null}
    onclick={onOpen}
  >
    <!-- The plate answers hover, focus and selection with a ring, so the tile
         reads as the door to the group chat rather than as decoration. -->
    <span
      class="flex size-24 items-center justify-center bg-brand-plate outline-1 outline-offset-2 transition-[outline-color] duration-150 group-hover:outline-border-strong group-focus-visible:outline-foreground {selected
        ? 'outline-foreground'
        : 'outline-transparent'}"
    >
      {#if iconUrl}
        <img src={iconUrl} alt="" aria-hidden="true" class="size-14 object-contain" />
      {:else}
        <AssistantIcon mark="mark" size={56} class="text-brand-ink" />
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
    <span class="-mt-1.5 text-xs text-dimmed group-hover:text-muted">Group chat</span>
  </button>
</div>
