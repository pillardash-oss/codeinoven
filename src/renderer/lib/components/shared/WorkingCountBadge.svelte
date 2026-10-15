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
  /**
   * A colour mark shows its swatches in place of a glyph.
   *
   * It wears the same box as a counted badge, for the same reason that badge
   * wears one: the mark lands on the item's own glyph, and bare swatches and a
   * bare digit over a foreground-coloured icon are unreadable at this size. The
   * box is what makes the mark legible wherever the host anchors it.
   */
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
  <!-- Every indicator is a filled, bordered chip: the fill lifts the mark off
       whatever it lands on, which on the rail is the item's own icon. -->
  <span
    class="flex h-3.5 min-w-3.5 items-center justify-center gap-px border border-border bg-elevated px-1 text-[0.5625rem] font-semibold tabular-nums shadow-sm {colorOnly
      ? ''
      : toneClass} {className}"
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
