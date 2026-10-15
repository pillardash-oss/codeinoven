<script lang="ts">
  import type { Component } from 'svelte'

  interface Props {
    /** Icon identifying what is being counted (threads, chats…). */
    icon: Component
    /** How many items are currently active; the badge renders nothing at zero. */
    count: number
    /** Accessible name and tooltip text describing the real count. */
    label: string
    /** Status tone driving the badge color: working (info), attention
     *  (warning), error (danger), or retry (warning). */
    tone?: 'working' | 'attention' | 'error' | 'retry'
    /** Optional explicit status accents, used for unread notification colours. */
    colors?: string[]
    /** Counts above this render as `<max>+` so the pill never grows past two glyphs. */
    max?: number
    class?: string
  }

  let {
    icon,
    count,
    label,
    tone = 'working',
    colors,
    max = 9,
    class: className = ''
  }: Props = $props()

  let toneClass = $derived.by((): string => {
    switch (tone) {
      case 'attention':
      case 'retry':
        return 'text-warning'
      case 'error':
        return 'text-danger'
      default:
        return 'text-thread-working'
    }
  })

  let display = $derived(count > max ? `${max}+` : String(count))
  /** A colour indicator is its own mark, so it carries no box: the swatches are
   *  the state, and a border, a fill, a padding and a shadow around them only
   *  added noise to the rail. A counted badge keeps its box, because there the
   *  count is the mark and the box is what makes it legible over the glyph. */
  let colorOnly = $derived(Boolean(colors?.length))
  /**
   * The colour the count is written in: the mark's own.
   *
   * A counted badge writes its number in its tone, so a colour mark has to write
   * its number in the colour it stands for. Without this the number has no colour
   * at all and inherits whatever hosts the badge, which on the rail is the muted
   * icon tone: legible nowhere and reading as disabled rather than as a count.
   */
  let markColor = $derived(colors?.[0])
</script>

{#if count > 0}
  {@const Icon = icon}
  <!-- A counted badge is a filled, bordered box, so it can afford the host's
       overhang: over the rail's current-item surface it blends and reads as a
       chip laid on top. A bare swatch mark cannot. The active item draws a 2px
       accent bar down the item's right edge, and a mark that overhung the same
       way would sit across that line and cut it, which reads as a glitch rather
       than as a chip. The mark therefore cancels the overhang to sit inside its
       own item's corner, with a little air before the accent. -->
  <span
    class="flex items-center gap-px text-[0.5625rem] font-semibold tabular-nums {colorOnly
      ? 'mr-2'
      : `h-3.5 min-w-3.5 justify-center border border-border bg-elevated px-1 shadow-sm ${toneClass}`} {className}"
    role="status"
    aria-label={label}
    title={label}
  >
    {#if colorOnly}
      <span class="flex items-center gap-px" aria-hidden="true">
        {#each colors as accent (accent)}
          <span class="h-1.5 w-1.5" style:background={accent}></span>
        {/each}
      </span>
      <span style:color={markColor}>{display}</span>
    {:else}
      <Icon size={8} strokeWidth={2.6} aria-hidden="true" />
      {display}
    {/if}
  </span>
{/if}
