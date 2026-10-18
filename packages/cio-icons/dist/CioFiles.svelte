<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Workspace files
  Workspace files: the folder with its tab inked, open at the bottom, with one
  child panel hanging off a short connector below and to the right of it. Two
  equal panels were tried first and read as two files rather than as a tree; a
  first attempt at this one let the child overlap the folder and read as one
  smudged block.
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
    transform="translate(-1.870 -2.439) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <path d="M3.4 11.6V6.6a1.6 1.6 0 0 1 1.6-1.6h2.9l1.9 2.4h5.2a1.6 1.6 0 0 1 1.6 1.6v2.6" /><rect
      x="3.3"
      y="4.8"
      width="6.4"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M7.4 11.6v2.4a2 2 0 0 0 2 2h2.2" /><rect
      x="11.6"
      y="12.6"
      width="9"
      height="7.4"
      rx="0"
    />
  </g>
</svg>
