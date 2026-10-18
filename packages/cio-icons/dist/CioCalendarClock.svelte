<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Scheduled
  Scheduled: the clock set inside the calendar rather than over its corner, so
  no stroke of one crosses the other. The clock the first pass hung over the
  edge put its ring through the calendar frame.
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
    transform="translate(-1.870 -1.870) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <rect x="3.4" y="5.4" width="17.2" height="15.2" rx="0" /><rect
      x="3.4"
      y="5.4"
      width="17.2"
      height="4.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M8.2 3.4v4" /><path d="M15.8 3.4v4" /><circle cx="15.6" cy="15.2" r="3.6" /><circle
      cx="15.6"
      cy="15.2"
      r="0.9"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M15.6 13.2v2" /><path d="M15.6 15.2h1.6" />
  </g>
</svg>
