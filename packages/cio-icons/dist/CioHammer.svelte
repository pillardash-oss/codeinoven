<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Engineering
  Engineering: a hammer, head solid and handle swung out below it, which is
  the mark the app puts on build and engineering work rather than on a
  setting.
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
    transform="translate(-1.351 -1.351) scale(1.2120)"
    stroke-width={cioStrokeWidth(weight, 1.212)}
  >
    <g transform="rotate(-45 8.6 8.6)"
      ><rect x="3.4" y="6.2" width="10.4" height="4.8" rx="0" /><rect
        x="6.6"
        y="6.2"
        width="4.4"
        height="4.8"
        stroke="none"
        style="fill: var(--icon-anchor, currentColor)"
      /></g
    ><path d="M10.2 10.2 18.8 18.8" />
  </g>
</svg>
