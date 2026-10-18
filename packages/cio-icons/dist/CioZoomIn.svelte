<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Zoom in
  Zoom in: the lens with a solid plus in it, so it reads as a search being
  narrowed rather than a plain find.
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
    transform="translate(-2.376 -2.376) scale(1.1706)"
    stroke-width={cioStrokeWidth(weight, 1.1706)}
  >
    <circle cx="10.6" cy="10.6" r="6.8" /><path d="M15.6 15.6 20.4 20.4" /><rect
      x="9.6"
      y="6.6"
      width="2"
      height="8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="6.6"
      y="9.6"
      width="8"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
