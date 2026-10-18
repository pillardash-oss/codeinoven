<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Tree list
  Tree list: a root rung with a spine down from it and two indented rungs,
  which is a hierarchy read as a list. The workspace tree keeps its own folder
  mark; this is the shape of the indentation itself.
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
    transform="translate(-5.453 -4.398) scale(1.4077)"
    stroke-width={cioStrokeWidth(weight, 1.4077)}
  >
    <rect
      x="4.6"
      y="5.5"
      width="4.6"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M7.2 7.7v9.2" /><path d="M7.2 11h4" /><path d="M7.2 15.8h4" /><rect
      x="11.2"
      y="9.9"
      width="9"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="11.2"
      y="14.7"
      width="7"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
