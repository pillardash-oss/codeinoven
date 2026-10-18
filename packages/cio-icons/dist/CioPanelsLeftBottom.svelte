<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Split left and bottom
  Split left and bottom: a frame divided once down the left and once across
  the bottom, which is a three-pane layout.
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
    <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="0" /><path d="M9.6 4.6v14.8" /><path
      d="M3.4 13.8h17.2"
    /><rect
      x="3.4"
      y="4.6"
      width="6.2"
      height="9.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
