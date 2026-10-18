<script lang="ts">
  import type { Component, Snippet } from 'svelte'
  import { slide } from 'svelte/transition'
  import CardHead from './CardHead.svelte'
  import type { CardChipData } from './CardTimer.svelte'
  import { dismissSlide, foldSlide } from './card-motion'

  interface Props {
    /** Accessible name of the stack. */
    label: string
    icon?: Component
    title: string
    /** Chips beside the title: a count, a notice. */
    meta?: Snippet
    /** The reading at the far right, before the fold. */
    chip?: CardChipData
    /** Extra controls before the fold, such as a queue menu. */
    controls?: Snippet
    folded?: boolean
    foldLabel?: string
    /** The agent left work unfinished: warning edge and warning head. */
    warn?: boolean
    /**
     * Another card sits directly above this one. The boundary between two
     * stacked surfaces is a broken line, the same rule the composer draws
     * between the message and its toolbar; the stack above drops its own bottom
     * rule so this card's top rule carries the join.
     */
    stackedAbove?: boolean
    body?: Snippet
    foot?: Snippet
    class?: string
  }

  let {
    label,
    icon,
    title,
    meta,
    chip,
    controls,
    folded = $bindable(false),
    foldLabel,
    warn = false,
    stackedAbove = false,
    body,
    foot,
    class: className = ''
  }: Props = $props()

  /* Each side carries its own colour, so the top rule can be the join with the
     card above without fighting the warning edge for the same declaration. */
  const frameClass = $derived(
    [
      'border border-b-0 bg-surface',
      warn ? 'border-l-[3px] border-l-warning border-r-warning' : 'border-l-border border-r-border',
      stackedAbove
        ? 'border-t-border-strong [border-top-style:dashed]'
        : warn
          ? 'border-t-warning'
          : 'border-t-border',
      className
    ].join(' ')
  )
</script>

<!-- A stack that sits on the composer's top edge: it drops its own bottom rule so
the next surface's top rule carries the join, and the head keeps the shared card
shape. That rule is the composer's own dashed edge when the composer is below,
and a broken line when another card is. The task list takes the warning edge when
the agent left tasks open, which is also what inks its head. -->
<section out:slide={dismissSlide()} class={frameClass} aria-label={label}>
  <CardHead
    {icon}
    {title}
    {meta}
    {chip}
    {controls}
    bind:folded
    {foldLabel}
    tone={warn ? 'warn' : 'default'}
    divider={false}
  />

  {#if !folded && body}
    <div class="border-t border-border" transition:slide={foldSlide()}>
      {@render body()}
    </div>
  {/if}

  {#if !folded && foot}
    {@render foot()}
  {/if}
</section>
