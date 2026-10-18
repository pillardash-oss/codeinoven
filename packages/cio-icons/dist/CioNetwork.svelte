<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Network
  Network: one node above two joined ones, the two lower ones solid, which is
  a coordinator with its workers.
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
    <rect x="9.4" y="3.4" width="5.2" height="4.2" rx="0" /><rect
      x="3.4"
      y="16.4"
      width="5.2"
      height="4.2"
      rx="0"
    /><rect x="15.4" y="16.4" width="5.2" height="4.2" rx="0" /><path d="M12 7.6v4" /><path
      d="M12 11.6 6 16.4"
    /><path d="M12 11.6 18 16.4" /><circle
      cx="6"
      cy="18.5"
      r="1.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle
      cx="18"
      cy="18.5"
      r="1.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
