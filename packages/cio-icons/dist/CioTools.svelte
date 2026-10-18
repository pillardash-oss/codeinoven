<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Tools
  Tools: a socket spanner. This is the spec studio toggle, so it has to read
  as engineering work rather than as an office. The case Lucide draws is a box
  with a handle on it, which is what luggage looks like.
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
    transform="translate(-4.739 0.804) scale(1.3177)"
    stroke-width={cioStrokeWidth(weight, 1.3177)}
  >
    <path d="M20.04 4.41 18.85 8.85 14.41 10.04 11.16 6.79 12.35 2.35 16.79 1.16Z" /><circle
      cx="15.6"
      cy="5.6"
      r="1.9"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path
      d="M14.41 10.04 11.16 6.79 4.37 13.58 7.62 16.83Z"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
