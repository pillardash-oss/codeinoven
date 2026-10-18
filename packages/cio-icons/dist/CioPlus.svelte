<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Add
  Add: a solid vertical bar crossed by one stroke, so it cannot be mistaken
  for the close cross at 12px.
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
    transform="translate(-3.888 -3.888) scale(1.3240)"
    stroke-width={cioStrokeWidth(weight, 1.324)}
  >
    <rect
      x="10.9"
      y="4.6"
      width="2.2"
      height="14.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M4.6 12h14.8" />
  </g>
</svg>
