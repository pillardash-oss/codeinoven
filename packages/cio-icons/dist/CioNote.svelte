<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Thread note
  Thread note: a quill. The vane runs both sides of the shaft and tapers to a
  point at each end, the shaft carries on past the vane to the nib, and one
  solid band crosses the middle. The mark it replaces hung a card off a bar on
  the left, which made it narrower than every mark beside it, and the pass
  after that was a single-sided blade, which read as the bowl of a spoon.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="square"
  stroke-linejoin="miter"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g transform="translate(-0.919 -2.442) scale(1.1400)" stroke-width={cioStrokeWidth(weight, 1.14)}>
    <path d="M4.4 19.6Q5.3 8.9 19.6 4.4Q15.1 18.7 4.4 19.6Z" /><path
      d="M19.6 4.4 3.6 20.4"
    /><circle
      cx="3.6"
      cy="20.4"
      r="1.9"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
