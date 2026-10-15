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
    body,
    foot,
    class: className = ''
  }: Props = $props()
</script>

<!-- A stack that sits on the composer's top edge: it drops its own bottom rule so
the composer's dashed top rule carries the join, and the head keeps the shared
card shape. The task list takes the warning edge when the agent left tasks open,
which is also what inks its head. -->
<section
  out:slide={dismissSlide()}
  class="border border-b-0 bg-surface {warn
    ? 'border-warning border-l-[3px]'
    : 'border-border'} {className}"
  aria-label={label}
>
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
