<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Display
  Display: a screen on a stand with one solid line of content, which is what
  separates it from the terminal frame.
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
    transform="translate(-1.870 -2.101) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <rect x="3.4" y="4.8" width="17.2" height="11.4" rx="0" /><rect
      x="6.4"
      y="7.6"
      width="8"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M12 16.2v3.4" /><path d="M8.6 19.6h6.8" />
  </g>
</svg>
