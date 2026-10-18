<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Approved
  Approved: a hand with the thumb up over a solid cuff, which is a review
  given rather than a check made.
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
  <g
    transform="translate(-2.290 -2.262) scale(1.2086)"
    stroke-width={cioStrokeWidth(weight, 1.2086)}
  >
    <path
      d="M7.6 10.6 10.8 3.8a2.2 2.2 0 0 1 2.9 2.9l-1.3 3.3h4.9a2 2 0 0 1 2 2.4l-1.2 6a2 2 0 0 1-2 1.6H7.6"
    /><rect
      x="3.4"
      y="10.6"
      width="4.2"
      height="9.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
