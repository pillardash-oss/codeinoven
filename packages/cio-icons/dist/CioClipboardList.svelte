<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Question list
  Question list: the clipboard with its solid clip and three lines, which is a
  set of things to answer.
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
    transform="translate(-2.731 -3.163) scale(1.2276)"
    stroke-width={cioStrokeWidth(weight, 1.2276)}
  >
    <path d="M8.6 4.8H6.4v15.6h11.2V4.8h-2.2" /><rect
      x="9.2"
      y="3.4"
      width="5.6"
      height="3"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="7.8"
      y="11"
      width="8.4"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="7.8"
      y="14.6"
      width="5.6"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="7.8"
      y="18.2"
      width="7"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
