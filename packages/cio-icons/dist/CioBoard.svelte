<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Board
  Board: a header rule and three even columns.
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
    transform="translate(-3.512 -3.194) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <path d="M4.4 5.8h15.2" />
    <rect
      x="5.2"
      y="9.4"
      width="3.2"
      height="9.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
    <rect
      x="10.4"
      y="9.4"
      width="3.2"
      height="9.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
    <rect
      x="15.6"
      y="9.4"
      width="3.2"
      height="9.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
