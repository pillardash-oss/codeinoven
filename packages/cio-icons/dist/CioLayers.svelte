<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Layers
  Layers: one plane above two, the top one carrying a solid edge so the stack
  reads in depth.
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
    transform="translate(-0.836 0.443) scale(1.0696)"
    stroke-width={cioStrokeWidth(weight, 1.0696)}
  >
    <path d="M12 4.4 20.4 9 12 13.6 3.6 9Z" /><rect
      x="9.6"
      y="8.2"
      width="4.8"
      height="1.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M3.6 12.6 12 17.2l8.4-4.6" />
  </g>
</svg>
