<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Skip
  Skip: a solid triangle against a solid bar. The bar is the anchor and it is
  what says the motion stops here.
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
    transform="translate(-11.114 -10.736) scale(1.8947)"
    stroke-width={cioStrokeWidth(weight, 1.8947)}
  >
    <path
      d="M6.4 6.4 14 12l-7.6 5.6Z"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="15.6"
      y="6.4"
      width="2.4"
      height="11.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
