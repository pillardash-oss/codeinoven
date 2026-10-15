<script lang="ts">
  import type { Component, Snippet } from 'svelte'
  import CardFoldToggle from './CardFoldToggle.svelte'
  import CardTimer, { type CardChipData } from './CardTimer.svelte'

  interface Props {
    /** Leading mark, drawn muted. Omit for a card whose title says enough. */
    icon?: Component
    /** The card's name. Truncates; it never wraps the row. */
    title: string
    /** Chips that belong beside the title: a count, a status tag, a notice. */
    meta?: Snippet
    /** The reading at the far right of the row, before the fold. */
    chip?: CardChipData
    /**
     * Quiet card-level actions in the head's right cluster, before the reading
     * and the fold: explain, quick chat. They arrive before the chip, so the
     * reading stays the last thing read before the controls.
     */
    actions?: Snippet
    /** Extra controls that sit before the fold, such as a close button. */
    controls?: Snippet
    /**
     * Fold state, bound so the owning card can gate its own body and footer on
     * it. Omit `foldLabel` for a card that does not fold.
     */
    folded?: boolean
    /** Card name used by the fold control's title and accessible label. */
    foldLabel?: string
    /** A rule under the header. Stacks that separate their body themselves
     *  turn it off, so the head and the first row never double up. */
    divider?: boolean
    /** `warn` inks the mark and the name, for a head that reports trouble. */
    tone?: 'default' | 'warn'
    class?: string
  }

  let {
    icon,
    title,
    meta,
    chip,
    actions,
    controls,
    folded = $bindable(false),
    foldLabel,
    divider = true,
    tone = 'default',
    class: className = ''
  }: Props = $props()

  const titleClass = $derived(tone === 'warn' ? 'text-warning' : 'text-foreground')
  const iconClass = $derived(tone === 'warn' ? 'text-warning' : 'text-muted')
</script>

<!-- The design's card head: icon, title, then the card's quiet actions, then the
reading, then the fold at the far right. Every card that can fold folds from here,
so one row shape serves the whole composer stack. -->
<div
  class={[
    'flex shrink-0 items-center gap-2 px-3 py-2',
    divider && !(foldLabel !== undefined && folded) && 'border-b border-border',
    className
  ]}
>
  <div class="flex min-w-0 flex-1 items-center gap-1.5">
    {#if icon}
      {@const Icon = icon}
      <Icon size={14} class="shrink-0 {iconClass}" />
    {/if}
    <p class="min-w-0 truncate text-[0.8125rem] font-semibold {titleClass}">{title}</p>
    {@render meta?.()}
  </div>

  {@render actions?.()}
  {#if chip}
    <CardTimer {...chip} />
  {/if}
  {@render controls?.()}
  {#if foldLabel !== undefined}
    <CardFoldToggle bind:folded label={foldLabel} />
  {/if}
</div>
