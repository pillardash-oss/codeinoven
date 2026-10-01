<script module lang="ts">
  import type { Component, Snippet } from 'svelte'
  import type { ThreadStatusTone } from '$shared/thread-status-policy'

  export interface ContextDockAppearance {
    /** The accent the identity resolved to, always present: a colour alone draws
     *  as a filled disc. */
    color: string
    /** The identity's own mark as an image data URL, when it has one. */
    iconUrl?: string | null
  }

  export interface ContextDockItem {
    id: string
    /** Used for both the tooltip and the accessible name. */
    label: string
    /** Omit in favor of `countLabel` for items that show a number instead of an icon. */
    icon?: Component
    /**
     * The identity the tool stands for when that identity is the user's own
     * rather than a fixed concept: the tool draws this in place of `icon`, so the
     * rail carries the colour and the mark of the thing currently in use.
     */
    appearance?: ContextDockAppearance
    /** Renders as plain text instead of `icon`   e.g. the message-history count. */
    countLabel?: string
    active: boolean
    /** Renders a small status dot on the icon   e.g. pending memory proposals.
     *  Colours and variants flow through the global `ThreadStatusTone` palette
     *  (same vocabulary as thread rows and `StatusBadge`), so the rail can
     *  mirror any thread tone, including `working-paused` for will-retry. */
    badge?: ThreadStatusTone
    /** Accessible description for the badge, required whenever `badge` is set. */
    badgeTitle?: string
    /** Renders a compact neutral count badge above the tool icon. */
    countBadge?: string
    countBadgeTone?: 'working'
    /** Coloured emphasis: amber for attention-worthy tools (e.g. a thread note),
     *  info for ephemeral tools that match their in-panel icon colour. */
    tone?: 'warning' | 'info'
    /**
     * A floating flyout (e.g. a dropdown) docked to this specific item. Rendered
     * as a sibling of the trigger button inside a shared `position: relative`
     * wrapper, so it anchors to the item itself   immune to the item's position
     * shifting within the rail. Content is responsible for its own `absolute`
     * positioning (typically `right-full` to dock to the left of the rail).
     */
    menu?: Snippet
    onSelect: () => void
    onContextMenu?: (event: MouseEvent) => void
  }
</script>

<script lang="ts">
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import RailHighlight from './RailHighlight.svelte'

  interface Props {
    /** Ordered groups. Empty groups are dropped so no stray hairline renders. */
    groups: ContextDockItem[][]
  }

  let { groups }: Props = $props()

  let visibleGroups = $derived(groups.filter((group) => group.length > 0))

  /** Identity of every item and which one is current, both of which move the
   *  shared highlight. The dock's own box never resizes when a tool takes over,
   *  so nothing else would re-measure it. */
  let highlightRevision = $derived(
    visibleGroups
      .map((group) => group.map((item) => `${item.id}:${item.active}`).join(','))
      .join('|')
  )

  /** Toned tools keep their colour in every state so the rail icon reads as the
   *  same tool as its panel icon; the shared highlight behind the current item
   *  paints the active background for every tool. */
  function toneClass(item: ContextDockItem): string {
    if (item.tone === 'warning') return 'text-warning hover:bg-elevated'
    if (item.tone === 'info') {
      return item.active ? 'text-info' : 'text-info/80 hover:bg-elevated hover:text-info'
    }
    return item.active ? 'text-foreground' : 'text-muted hover:bg-elevated hover:text-foreground'
  }
</script>

<!--
  The dock lip: a fixed-width vertical rail pinned to the right window edge. It
  never scrolls with the panel and never resizes, so the tool icons stay in the
  same place whether the context sidebar is open or closed.
-->
<nav
  class="relative flex h-full w-10 shrink-0 flex-col items-center gap-0.5 bg-surface py-2"
  aria-label="Context tools"
  data-region="context-dock"
>
  <!-- One current-tool surface for the whole dock, so switching tools slides it
       to the icon that took over instead of fading two separate ones. -->
  <RailHighlight revision={highlightRevision} currentValue="true" accentSide="left" />
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
          oncontextmenu={item.onContextMenu}
        >
          {#if item.countLabel !== undefined}
            <span class="text-[0.6875rem] font-semibold tabular-nums">{item.countLabel}</span>
          {:else if item.appearance}
            {#if item.appearance.iconUrl}
              <img src={item.appearance.iconUrl} alt="" class="h-4 w-4 rounded-sm object-contain" />
            {:else}
              <span
                class="h-3.5 w-3.5 rounded-full"
                style="background-color: {item.appearance.color}"
              ></span>
            {/if}
          {:else if Icon}
            <Icon size={16} strokeWidth={1.8} />
          {/if}
          {#if item.badge}
            <span class="absolute -top-0.5 -right-0.5 flex items-start">
              {#if item.badge === 'working' || item.badge === 'working-paused'}
                <StatusBadge
                  tone={item.badge}
                  variant="spinner"
                  animated
                  title={item.badgeTitle ?? item.label}
                />
              {:else}
                <StatusBadge tone={item.badge} title={item.badgeTitle ?? item.label} />
              {/if}
            </span>
          {/if}
          {#if item.countBadge !== undefined}
            <span
              class="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[0.5625rem] font-semibold leading-none tabular-nums ring-1 {item.countBadgeTone ===
              'working'
                ? 'bg-thread-working text-on-primary ring-thread-working'
                : 'bg-raised text-muted ring-border'}"
              aria-hidden="true"
            >
              {item.countBadge}
            </span>
          {/if}
        </button>
        {@render item.menu?.()}
      </div>
    {/each}
  {/each}
</nav>
