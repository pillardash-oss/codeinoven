<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cardFrameClass, type CardFramePlacement } from './card-frame'

  interface Props {
    placement: CardFramePlacement
    /** Shown to assistive technology; the card's own head carries the name. */
    label: string
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    /** Extra classes the owning card needs, e.g. its own scroll region. */
    class?: string
    children: Snippet
  }

  let {
    placement,
    label,
    stackedAbove = false,
    joinsBelow = false,
    class: className = '',
    children
  }: Props = $props()
</script>

<!-- The design's card frame: a square surface with a 1px rule and the placement
mark on its left edge, so a reader can tell at a glance whether the card is
answering for the composer or reporting from the top of the thread. A card that
stacks on the composer drops its own bottom rule and takes the broken top rule
when another card sits above it, so the boundary between stacked surfaces is a
single broken line. -->
<section
  class={cardFrameClass(placement, className, { stackedAbove, joinsBelow })}
  aria-label={label}
>
  {@render children()}
</section>
