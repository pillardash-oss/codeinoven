<script lang="ts">
  import { Info, TriangleAlert } from '@lucide/svelte'
  import type { Component, Snippet } from 'svelte'
  import { fly } from 'svelte/transition'
  import { rowArrive } from './card-motion'

  interface Props {
    /** Leading mark. Omit only for a notice that carries no icon. */
    icon?: Component
    /** `warn` and `danger` ink the whole row and drop the fill. */
    tone?: 'default' | 'warn' | 'danger'
    /**
     * Where the notice sits, which decides its edge.
     *
     * - `box`      a notice inside a card: a framed row in the card's body
     * - `composer` a notice on the composer itself: no side rules and a dashed
     *              rule under it, the same dashed grammar the composer uses to
     *              separate the message from its controls
     */
    placement?: 'box' | 'composer'
    /** Rendered inside the row. */
    children: Snippet
    class?: string
  }

  let {
    icon,
    tone = 'default',
    placement = 'box',
    children,
    class: className = ''
  }: Props = $props()

  const Mark = $derived(icon ?? (tone === 'default' ? Info : TriangleAlert))

  const toneClass = $derived(
    tone === 'warn' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-muted'
  )

  const placementClass = $derived(
    placement === 'composer'
      ? 'border-b border-dashed border-border-strong bg-transparent'
      : tone === 'warn'
        ? 'border border-warning'
        : tone === 'danger'
          ? 'border border-danger'
          : 'border border-border bg-elevated'
  )
</script>

<!-- The design's notice row: one line of status that lives inside a card or on the
composer itself, in the same shape wherever it appears. It arrives and leaves on
its own motion: a notice is something that happened, so it rises into place and
fades back out when the state that carried it is gone. -->
<div
  class="flex items-start gap-2 px-2.5 py-2 text-xs {toneClass} {placementClass} {className}"
  transition:fly={rowArrive()}
>
  <Mark size={14} class="mt-0.5 shrink-0" />
  <p class="min-w-0 flex-1 leading-relaxed">
    {@render children()}
  </p>
</div>
