<script lang="ts">
  import { Bot, User } from '@lucide/svelte'
  import type { RepositoryMentionUser } from '$shared/types'
  import { mentionHandle } from './pr-mentions'

  interface Props {
    entries: RepositoryMentionUser[]
    activeIndex: number
    /** Text typed after `@`, without the sigil. Empty right after `@`. */
    query: string
    /** True while the repository directory is still loading behind the participants. */
    loading: boolean
    /**
     * Ceiling for the popover, in pixels, measured by the caller against the room
     * it actually has. See `mentionMenuMaxHeight`.
     */
    maxHeight: number
    onSelect: (user: RepositoryMentionUser) => void
  }

  let { entries, activeIndex, query, loading, maxHeight, onSelect }: Props = $props()

  let listElement: HTMLDivElement | undefined

  // Keep the highlighted row inside the scroller as the arrow keys move it.
  $effect(() => {
    const selectedIndex = activeIndex
    const entryCount = entries.length
    const frame = requestAnimationFrame(() => {
      if (selectedIndex < 0 || selectedIndex >= entryCount) return
      listElement
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  })

  const emptyLabel = $derived(
    loading
      ? 'Looking for accounts…'
      : query
        ? `No account matches @${query}`
        : 'No accounts to suggest'
  )
</script>

<!--
  Opens upward: the composer is pinned to the bottom of both the dock and the
  full screen rail, so the list has to grow into the conversation above it
  rather than off the bottom edge of the panel.
-->
<div
  bind:this={listElement}
  class="absolute bottom-full left-2 right-2 z-40 mb-1 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
  style="max-height: {maxHeight}px"
  role="listbox"
  aria-label="Mention an account on this pull request"
>
  {#if entries.length === 0}
    <p class="px-2 py-2 text-[0.625rem] text-dimmed">{emptyLabel}</p>
  {:else}
    {#each entries as entry (entry.login.toLowerCase())}
      <button
        type="button"
        class={[
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none',
          entry === entries[activeIndex]
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:bg-elevated'
        ]}
        role="option"
        aria-selected={entry === entries[activeIndex]}
        title={`Mention @${mentionHandle(entry)}`}
        onmousedown={(event: MouseEvent) => event.preventDefault()}
        onclick={() => onSelect(entry)}
      >
        {#if entry.bot}
          <Bot size={13} class="shrink-0 text-primary" aria-hidden="true" />
        {:else}
          <User size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        {/if}
        <span class="min-w-0 flex-1">
          <span class="block truncate font-mono">@{mentionHandle(entry)}</span>
          <span class="block truncate text-[0.625rem] text-dimmed">
            {entry.bot ? 'App account' : (entry.name ?? 'Repository account')}
          </span>
        </span>
      </button>
    {/each}
  {/if}
</div>
