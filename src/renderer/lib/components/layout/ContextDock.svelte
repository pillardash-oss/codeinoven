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

  export interface ContextDockCountBadge {
    text: string
    tone: 'neutral' | 'success' | 'danger'
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
    /** The work behind this item is emitting sound. */
    playing?: boolean
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
    /**
     * A stack of compact count badges at the icon's top-right, each with its
     * own tone. Used where one count cannot carry the whole story, e.g. a live
     * turn's insertions and deletions.
     */
    countBadges?: ContextDockCountBadge[]
    /** Coloured emphasis: amber for attention-worthy tools (e.g. a thread note),
     *  and nothing else   blue on the rail means work in progress, never the
     *  kind of tool an icon stands for. */
    tone?: 'warning'
    /**
     * A floating flyout (e.g. a dropdown) docked to this specific item. Rendered
     * as a sibling of the trigger button inside a shared `position: relative`
     * wrapper, so it anchors to the item itself   immune to the item's position
     * shifting within the rail. Content is responsible for its own `absolute`
     * positioning (typically `right-full` to dock to the left of the rail).
     */
    menu?: Snippet
    /**
     * Preview shown to the left of the item after a short hover, e.g. the
     * Changes summary. It is informational only   it never captures the click
     * and it hides as soon as the pointer leaves the icon (its own wrapper is
     * `pointer-events-none`), so it can never get stuck open.
     */
    flyout?: Snippet
    onSelect: () => void
    onContextMenu?: (event: MouseEvent) => void
  }
</script>

<script lang="ts">
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { onDestroy } from 'svelte'
  import RailHighlight from './RailHighlight.svelte'
  import RailAudioBadge from './RailAudioBadge.svelte'

  interface Props {
    /** Ordered groups. Empty groups are dropped so no stray hairline renders. */
    groups: ContextDockItem[][]
  }

  let { groups }: Props = $props()

  let visibleGroups = $derived(groups.filter((group) => group.length > 0))

  /**
   * The item whose hover preview is showing, or null.
   *
   * A short delay before showing keeps a pointer crossing the rail on its way
   * somewhere else from flashing a preview on every icon it passes. Hiding is
   * immediate: the preview is not interactive, so there is nothing to keep it
   * open for.
   */
  let hoveredId = $state<string | null>(null)
  let hoverTimer: ReturnType<typeof setTimeout> | null = null

  function showFlyout(id: string): void {
    cancelHoverTimer()
    hoverTimer = setTimeout(() => {
      hoverTimer = null
      hoveredId = id
    }, 220)
  }

  function hideFlyout(id: string): void {
    cancelHoverTimer()
    if (hoveredId === id) hoveredId = null
  }

  function cancelHoverTimer(): void {
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
  }

  onDestroy(cancelHoverTimer)

  /** Identity of every item and which one is current, both of which move the
   *  shared highlight. The dock's own box never resizes when a tool takes over,
   *  so nothing else would re-measure it. */
  let highlightRevision = $derived(
    visibleGroups
      .map((group) => group.map((item) => `${item.id}:${item.active}`).join(','))
      .join('|')
  )

  /** A toned tool   an attention-worthy entry such as a written thread note   keeps
   *  its colour in every state; the shared highlight behind the current item
   *  paints the active background for every tool, so an untinted icon reads as
   *  one more tool and never as a second class of thing. */
  function toneClass(item: ContextDockItem): string {
    if (item.tone === 'warning') return 'text-warning hover:bg-elevated'
    return item.active ? 'text-foreground' : 'text-muted hover:bg-elevated hover:text-foreground'
  }

  /** Tone for a stacked count badge; the surface base keeps it legible over
   *  whatever part of the icon it overlaps. */
  function countBadgeClass(tone: ContextDockCountBadge['tone']): string {
    if (tone === 'success') return 'bg-surface text-success ring-success/40'
    if (tone === 'danger') return 'bg-surface text-danger ring-danger/40'
    return 'bg-raised text-muted ring-border'
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
          class="relative flex h-8 w-8 shrink-0 items-center justify-center transition-colors duration-150 {toneClass(
            item
          )}"
          aria-label={item.label}
          aria-current={item.active ? 'true' : undefined}
          title={item.label}
          onpointerenter={item.flyout ? () => showFlyout(item.id) : undefined}
          onpointerleave={item.flyout ? () => hideFlyout(item.id) : undefined}
          onclick={item.onSelect}
          oncontextmenu={item.onContextMenu}
        >
          {#if item.countLabel !== undefined}
            <span class="text-[0.6875rem] font-semibold tabular-nums">{item.countLabel}</span>
          {:else if item.appearance}
            {#if item.appearance.iconUrl}
              <img src={item.appearance.iconUrl} alt="" class="h-4 w-4 object-contain" />
            {:else}
              <span class="h-3.5 w-3.5" style="background-color: {item.appearance.color}"></span>
            {/if}
          {:else if Icon}
            <Icon size={16} strokeWidth={1.8} />
          {/if}
          {#if item.playing}
            <RailAudioBadge label={item.label} />
          {/if}
          {#if item.badge}
            <span class="absolute -top-0.5 -right-0.5 flex items-start">
              {#if item.badge === 'working' || item.badge === 'working-paused'}
                <StatusBadge
                  tone={item.badge}
                  variant="spinner"
                  title={item.badgeTitle ?? item.label}
                />
              {:else}
                <StatusBadge tone={item.badge} title={item.badgeTitle ?? item.label} />
              {/if}
            </span>
          {/if}
          {#if item.countBadge !== undefined}
            <span
              class="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center px-1 text-[0.5625rem] font-semibold leading-none tabular-nums ring-1 {item.countBadgeTone ===
              'working'
                ? 'bg-thread-working text-on-primary ring-thread-working'
                : 'bg-raised text-muted ring-border'}"
              aria-hidden="true"
            >
              {item.countBadge}
            </span>
          {/if}
          {#if item.countBadges && item.countBadges.length > 0}
            <span class="absolute -top-1 -right-1 flex flex-col items-end gap-0.5">
              {#each item.countBadges as badge, badgeIndex (badgeIndex)}
                <span
                  class="flex h-3.5 min-w-3.5 items-center justify-center px-1 text-[0.5625rem] font-semibold leading-none tabular-nums ring-1 {countBadgeClass(
                    badge.tone
                  )}"
                  aria-hidden="true"
                >
                  {badge.text}
                </span>
              {/each}
            </span>
          {/if}
        </button>
        {#if item.flyout && hoveredId === item.id}
          <div class="pointer-events-none absolute top-1/2 right-full z-50 mr-1.5 -translate-y-1/2">
            {@render item.flyout()}
          </div>
        {/if}
        {@render item.menu?.()}
      </div>
    {/each}
  {/each}
</nav>
