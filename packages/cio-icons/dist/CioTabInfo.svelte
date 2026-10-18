<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Info tab
  Update: a readout plate carrying its own mark. The dot and the stem are 1.8
  units wide, above the one-device-pixel floor, which pass D's version of this
  glyph was not.
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
    transform="translate(-2.023 -2.023) scale(1.1686)"
    stroke-width={cioStrokeWidth(weight, 1.1686)}
  >
    <rect x="3.5" y="4.8" width="17" height="14.4" rx="0" />
    <circle cx="12" cy="9.3" r="1.8" stroke="none" style="fill: var(--icon-anchor, currentColor)" />
    <rect
      x="11.1"
      y="12.4"
      width="1.8"
      height="4.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
