<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Record
  Record: a capsule with a solid core in a cradle. The core is the anchor and
  the cradle is what makes it a microphone.
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
    <rect x="9.4" y="3.4" width="5.2" height="10" rx="0" /><rect
      x="10.8"
      y="5.8"
      width="2.4"
      height="5"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M6.4 11.6a5.6 5.6 0 0 0 11.2 0" /><path d="M12 17.2v3.4" />
  </g>
</svg>
