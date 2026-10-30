<script lang="ts">
  import { ICON_SIZE, RAIL_ICON_STROKE } from '$lib/components/icons/cio/scale'
  import { encodeShortcutTokens } from '$lib/keymap/keymap'
  import type { MediaActivity } from '$shared/media-activity'
  import RailAudioBadge from './RailAudioBadge.svelte'
  import type { Component, Snippet } from 'svelte'

  interface Props {
    /** Accessible name and tooltip text. */
    label: string
    icon: Component
    /**
     * Marks the item as the current destination. The rail paints the shared
     * surface behind this item (so it can slide between items), which leaves
     * the button itself with only the brightened label.
     */
    active?: boolean
    disabled?: boolean
    /** Symbolic key tokens from the keymap registry, shown in the tooltip chip. */
    shortcut?: readonly string[]
    /**
     * Icon colour. A toned item keeps its colour in every state, so a status
     * glyph such as the amber waiting clock reads while the rail is idle; the
     * neutral `default` tone still dims until current or hovered.
     */
    tone?: 'default' | 'primary' | 'danger' | 'accent'
    /** Spins the icon, for in-flight states such as a download. */
    spin?: boolean
    /** Determinate progress, replacing the icon with a ring and integer. */
    progress?: number
    /** Corner mark saying a browser behind this item is playing sound. */
    playing?: boolean
    recording?: boolean
    media?: readonly MediaActivity[]
    onSelect: () => void
    onHover?: () => void
    /** Corner content, e.g. an activity badge. */
    badge?: Snippet
  }

  let {
    label,
    icon: Icon,
    active = false,
    disabled = false,
    shortcut = [],
    tone = 'default',
    spin = false,
    progress,
    playing = false,
    recording = false,
    media,
    onSelect,
    onHover,
    badge
  }: Props = $props()

  const progressPercent = $derived(
    progress === undefined
      ? undefined
      : Number.isFinite(progress)
        ? Math.min(100, Math.max(0, Math.round(progress)))
        : 0
  )

  /**
   * Toned items (update status, errors) keep their colour even when the item is
   * not the current destination: the tone *is* the message, so dimming it hides
   * the only signal the user has that something needs attention. Neutral items
   * stay dimmed until they are current or hovered.
   */
  const toneClass = $derived.by((): string => {
    if (tone === 'danger') return 'text-danger hover:bg-elevated'
    if (tone === 'accent') return 'text-accent hover:bg-elevated'
    if (tone === 'primary') return 'text-primary hover:bg-elevated'
    return active ? 'text-primary' : 'text-dimmed hover:bg-elevated hover:text-muted'
  })
</script>

<!-- One rail item: the 32px tool button shared by the view rail's views and its
     utility controls. The current-item surface is painted by the rail itself
     (see `AppViewRail`), so this button only carries the glyph and its tone. -->
<button
  type="button"
  class="relative flex h-8 w-8 shrink-0 items-center justify-center transition-colors duration-150 {toneClass}"
  aria-label={label}
  aria-current={active ? 'page' : undefined}
  title={label}
  data-shortcut={encodeShortcutTokens(shortcut)}
  {disabled}
  onpointerenter={onHover}
  onclick={onSelect}
>
  {#if progressPercent !== undefined}
    <span class="relative flex h-6 w-6 items-center justify-center" aria-hidden="true">
      <svg class="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="10.5"
          stroke="currentColor"
          stroke-width="1.8"
          class="text-border"
        />
        <circle
          cx="12"
          cy="12"
          r="10.5"
          pathLength="100"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-dasharray={`${progressPercent} 100`}
          class="text-primary"
        />
      </svg>
      <span class="text-[0.5rem] font-medium leading-none tabular-nums text-foreground">
        {progressPercent}
      </span>
    </span>
  {:else}
    <Icon
      size={ICON_SIZE.rail}
      strokeWidth={RAIL_ICON_STROKE}
      class={spin ? 'animate-spin' : undefined}
    />
  {/if}
  {#if media?.length || playing || recording}
    <RailAudioBadge
      {label}
      activities={media ?? [
        ...(playing ? ['audio' as const] : []),
        ...(recording ? ['microphone' as const] : [])
      ]}
    />
  {/if}
  {@render badge?.()}
</button>
