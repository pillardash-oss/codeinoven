<script module lang="ts">
  import type { Component } from 'svelte'

  export interface ContextDockItem {
    id: string
    /** Used for both the tooltip and the accessible name. */
    label: string
    icon: Component
    active: boolean
    /** Renders a small status dot on the icon — e.g. pending memory proposals. */
    badge?: 'completed' | 'attention' | 'error'
    /** Accessible description for the badge, required whenever `badge` is set. */
    badgeTitle?: string
    /** Amber emphasis for attention-worthy tools (e.g. a thread note). */
    tone?: 'warning'
    onSelect: () => void
  }
</script>

<script lang="ts">
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'

  interface Props {
    /** Ordered groups. Empty groups are dropped so no stray hairline renders. */
    groups: ContextDockItem[][]
  }

  let { groups }: Props = $props()

  let visibleGroups = $derived(groups.filter((group) => group.length > 0))
</script>

<!--
  The dock lip: a fixed-width vertical rail pinned to the right window edge. It
  never scrolls with the panel and never resizes, so the tool icons stay in the
  same place whether the context sidebar is open or closed.
-->
<nav
  class="flex h-full w-10 shrink-0 flex-col items-center gap-0.5 border-l border-border bg-surface py-2"
  aria-label="Context tools"
  data-region="context-dock"
>
  {#each visibleGroups as group, groupIndex (groupIndex)}
    {#if groupIndex > 0}
      <div class="my-1.5 h-px w-5 shrink-0 bg-border" aria-hidden="true"></div>
    {/if}
    {#each group as item (item.id)}
      {@const Icon = item.icon}
      <button
        type="button"
        class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 {item.tone ===
        'warning'
          ? 'text-warning hover:bg-elevated'
          : item.active
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
        aria-label={item.label}
        aria-current={item.active ? 'true' : undefined}
        title={item.label}
        onclick={item.onSelect}
      >
        <span
          class="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary transition-opacity duration-150 {item.active
            ? 'opacity-100'
            : 'opacity-0'}"
          aria-hidden="true"
        ></span>
        <Icon size={16} strokeWidth={1.8} />
        {#if item.badge}
          <span class="absolute -top-0.5 -right-0.5 flex items-start">
            <StatusBadge kind={item.badge} title={item.badgeTitle ?? item.label} />
          </span>
        {/if}
      </button>
    {/each}
  {/each}
</nav>
