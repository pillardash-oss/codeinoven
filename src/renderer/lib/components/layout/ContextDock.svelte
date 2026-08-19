<script module lang="ts">
  import type { Component, Snippet } from 'svelte'

  export interface ContextDockItem {
    id: string
    /** Used for both the tooltip and the accessible name. */
    label: string
    /** Omit in favor of `countLabel` for items that show a number instead of an icon. */
    icon?: Component
    /** Renders as plain text instead of `icon` — e.g. the message-history count. */
    countLabel?: string
    active: boolean
    /** Renders a small status dot on the icon — e.g. pending memory proposals. */
    badge?: 'completed' | 'attention' | 'error'
    /** Accessible description for the badge, required whenever `badge` is set. */
    badgeTitle?: string
    /** Coloured emphasis: amber for attention-worthy tools (e.g. a thread note),
     *  info for ephemeral tools that match their in-panel icon colour. */
    tone?: 'warning' | 'info'
    /**
     * A floating flyout (e.g. a dropdown) docked to this specific item. Rendered
     * as a sibling of the trigger button inside a shared `position: relative`
     * wrapper, so it anchors to the item itself — immune to the item's position
     * shifting within the rail. Content is responsible for its own `absolute`
     * positioning (typically `right-full` to dock to the left of the rail).
     */
    menu?: Snippet
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

  /** Toned tools keep their colour in every state so the rail icon reads as the
   *  same tool as its panel icon; untoned tools use the neutral active styling. */
  function toneClass(item: ContextDockItem): string {
    if (item.tone === 'warning') return 'text-warning hover:bg-elevated'
    if (item.tone === 'info') {
      return item.active
        ? 'bg-elevated text-info'
        : 'text-info/80 hover:bg-elevated hover:text-info'
    }
    return item.active
      ? 'bg-elevated text-foreground'
      : 'text-muted hover:bg-elevated hover:text-foreground'
  }
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
      <div class="relative">
        <button
          type="button"
          class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 {toneClass(
            item
          )}"
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
          {#if item.countLabel !== undefined}
            <span class="text-[11px] font-semibold tabular-nums">{item.countLabel}</span>
          {:else if Icon}
            <Icon size={16} strokeWidth={1.8} />
          {/if}
          {#if item.badge}
            <span class="absolute -top-0.5 -right-0.5 flex items-start">
              <StatusBadge kind={item.badge} title={item.badgeTitle ?? item.label} />
            </span>
          {/if}
        </button>
        {@render item.menu?.()}
      </div>
    {/each}
  {/each}
</nav>
