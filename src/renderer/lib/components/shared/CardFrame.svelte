<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cardFrameClass, type CardFramePlacement } from './card-frame'

  interface Props {
    placement: CardFramePlacement
    /** Shown to assistive technology; the card's own head carries the name. */
    label: string
    /** Extra classes the owning card needs, e.g. its own scroll region. */
    class?: string
    children: Snippet
  }

  let { placement, label, class: className = '', children }: Props = $props()
</script>

<!-- The design's card frame: a square surface with a 1px rule and the placement
mark on its left edge, so a reader can tell at a glance whether the card is
answering for the composer or reporting from the top of the thread. -->
<section class={cardFrameClass(placement, className)} aria-label={label}>
  {@render children()}
</section>
