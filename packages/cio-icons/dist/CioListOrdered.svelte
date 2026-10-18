<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Numbered list
  Numbered list: rungs with the numerals drawn as strokes, because a solid dot
  would make it the plain list.
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
    transform="translate(-1.937 -2.458) scale(1.1706)"
    stroke-width={cioStrokeWidth(weight, 1.1706)}
  >
    <path d="M9.4 6.6h11" /><path d="M9.4 12h11" /><path d="M9.4 17.4h11" /><path
      d="M4.2 5.4 6 4.6v4.2"
    /><path d="M3.8 11a1.4 1.4 0 0 1 2.8 0c0 1-2.8 1.8-2.8 3.4h2.8" /><path
      d="M3.8 16.2h2.6l-1.6 1.6c1 .1 1.6.6 1.6 1.4a1.5 1.5 0 0 1-2.6.9"
    />
  </g>
</svg>
