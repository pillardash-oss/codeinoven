<script lang="ts">
  import { Volume2 } from '@lucide/svelte'
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
    /** Icon colour when the item is idle. */
    tone?: 'default' | 'primary' | 'danger' | 'accent'
    /** Spins the icon, for in-flight states such as a download. */
    spin?: boolean
    /** Determinate progress, replacing the icon with a ring and integer. */
    progress?: number
    /** Corner mark saying a browser behind this item is playing sound. */
    playing?: boolean
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

  /** Tonal items keep their colour in every state; the rest use the neutral
   *  idle/active palette shared by the view rail and the context dock. */
  const toneClass = $derived.by((): string => {
    if (active) return 'text-foreground'
    switch (tone) {
      case 'primary':
        return 'text-primary hover:bg-elevated'
      case 'danger':
        return 'text-danger hover:bg-elevated'
      case 'accent':
        return 'text-accent'
      default:
        return 'text-muted hover:bg-elevated hover:text-foreground'
    }
  })
</script>

<!-- One rail item: the 32px tool button shared by the view rail's views and its
     utility controls. The current-item surface is painted by the rail itself
     (see `AppViewRail`), so this button only carries the glyph and its tone. -->
<button
  type="button"
  class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 {toneClass}"
  aria-label={label}
  aria-current={active ? 'page' : undefined}
  title={label}
  data-shortcut={shortcut.length > 0 ? shortcut.join(',') : undefined}
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
    <Icon size={16} strokeWidth={1.8} class={spin ? 'animate-spin' : undefined} />
  {/if}
  {#if playing}
    <!-- The speaker rides the opposite corner from the badge stack, so a view can
         say "working" and "playing sound" at the same time without either mark
         hiding the other. It is a status, not a control: the mute toggle lives
         on the tab row the sound actually belongs to. -->
    <span
      class="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-elevated text-info shadow-sm"
      role="status"
      aria-label={`${label} is playing audio`}
      title={`${label} is playing audio`}
    >
      <Volume2 size={9} strokeWidth={2.6} aria-hidden="true" />
    </span>
  {/if}
  {@render badge?.()}
</button>
