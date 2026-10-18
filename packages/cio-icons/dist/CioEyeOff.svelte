<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Hide
  Hide: the eye struck through, the pupil still solid so it reads as the same
  eye turned off.
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
    transform="translate(-0.646 -0.646) scale(1.0539)"
    stroke-width={cioStrokeWidth(weight, 1.0539)}
  >
    <path d="M2.6 12s3.6-6.6 9.4-6.6S21.4 12 21.4 12s-3.6 6.6-9.4 6.6S2.6 12 2.6 12Z" /><circle
      cx="12"
      cy="12"
      r="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M4.4 19.6 19.6 4.4" />
  </g>
</svg>
