<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Marketplace
  Marketplace: a shop front with its awning inked and a door cut into it,
  which is somewhere things are offered rather than a box they were shipped
  in.
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
    transform="translate(-3.324 -5.314) scale(1.2770)"
    stroke-width={cioStrokeWidth(weight, 1.277)}
  >
    <path d="M4.6 10.4v8a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-8" /><rect
      x="3.4"
      y="6"
      width="17.2"
      height="4.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="10.4"
      y="14.4"
      width="3.2"
      height="5.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
