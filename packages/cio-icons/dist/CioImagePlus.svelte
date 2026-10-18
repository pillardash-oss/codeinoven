<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Add an image
  Add an image: the picture standing beside the solid plus rather than
  carrying it, so neither the frame nor the plus gives up its shape to the
  other.
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
    transform="translate(-1.892 -1.946) scale(1.1622)"
    stroke-width={cioStrokeWidth(weight, 1.1622)}
  >
    <rect x="3.4" y="4.6" width="11.2" height="14.8" rx="0" /><circle
      cx="7"
      cy="8.8"
      r="1.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M4.4 16.8 7.8 13.4l2.2 2.2 1.6-1.6" /><rect
      x="17"
      y="11.6"
      width="2"
      height="8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="14.6"
      y="14.6"
      width="6.8"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
