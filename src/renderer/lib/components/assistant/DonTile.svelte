<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import ThreadStateCounts from '$lib/components/shared/ThreadStateCounts.svelte'
  import type { ThreadStateCounts as ThreadStateCountsValue } from '$lib/thread-state-counts'
  import type { Assistant } from '$shared/types'
  import { formatCompactAge } from '$shared/date-time-format'
  import { relativeTimeClock } from '$lib/relative-time.svelte'

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
    /** When Don's conversation last moved, so the tile says how long it has been. */
    lastWorkedAt?: number | null
    /** Don's working, attention and error breakdown, as the other rows wear it. */
    stateCounts: ThreadStateCountsValue
    onOpen: () => void
  }

  let {
    assistant,
    threadId,
    selected,
    iconUrl = null,
    ready,
    lastWorkedAt = null,
    stateCounts,
    onOpen
  }: Props = $props()

  const name = $derived(assistant?.name?.trim() || 'Don')
  const title = $derived(ready ? `Open ${name}` : `${name} needs a model before it can take work`)
  const lastWorkedLabel = $derived(
    lastWorkedAt ? formatCompactAge(lastWorkedAt, relativeTimeClock.now) : ''
  )

  $effect(() => relativeTimeClock.hold())
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
    <!-- The plate answers hover, focus and selection with a quiet ring: enough
         to read as the door to Don's conversation, never bright enough to pull the
         eye off the list it opens. -->
    <span
      class="flex size-24 items-center justify-center bg-brand-plate outline-1 outline-offset-2 transition-[outline-color] duration-150 group-hover:outline-border group-focus-visible:outline-border-strong {selected
        ? 'outline-border-strong'
        : 'outline-transparent'}"
    >
      {#if iconUrl}
        <img src={iconUrl} alt="" aria-hidden="true" class="size-14 object-contain" />
      {:else}
        <AssistantIcon mark="mark" size={56} class="text-brand-ink" />
      {/if}
    </span>
    <!-- One line under the plate: who it is, when it last worked, and what its
         threads are doing. -->
    <span class="flex items-center gap-1.5 text-sm font-medium text-foreground">
      {name}
      {#if !ready}
        <CioAttention
          size={12}
          class="text-warning"
          title={`${name} has no model yet`}
          aria-label={`${name} has no model yet`}
        />
      {/if}
      {#if lastWorkedLabel}
        <span class="text-dimmed" aria-hidden="true">·</span>
        <span class="text-xs font-normal text-dimmed group-hover:text-muted">{lastWorkedLabel}</span
        >
      {/if}
      <ThreadStateCounts counts={stateCounts} />
    </span>
  </button>
</div>
