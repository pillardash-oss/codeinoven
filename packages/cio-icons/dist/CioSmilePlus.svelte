<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Add a reaction
  Add a reaction: a face with the solid plus at its shoulder, which is a
  reaction being put on rather than a face alone.
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
    transform="translate(-1.983 -1.750) scale(1.1049)"
    stroke-width={cioStrokeWidth(weight, 1.1049)}
  >
    <circle cx="11.4" cy="12.6" r="7.8" /><circle
      cx="8.6"
      cy="10.6"
      r="1.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle
      cx="14.2"
      cy="10.6"
      r="1.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M8.4 15.2a4.4 4.4 0 0 0 6 0" /><rect
      x="18.4"
      y="3.6"
      width="2"
      height="6.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="16.2"
      y="5.8"
      width="6.4"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
