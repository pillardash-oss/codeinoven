<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Unguarded
  Unguarded: the crest struck through, the crest kept whole underneath so the
  shape still reads.
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
    transform="translate(-1.514 -1.949) scale(1.1261)"
    stroke-width={cioStrokeWidth(weight, 1.1261)}
  >
    <path d="M12 3.6 19.4 6.6v6.2c0 3.9-2.9 7.1-7.4 8.4-4.5-1.3-7.4-4.5-7.4-8.4V6.6Z" /><path
      d="M4.4 19.6 19.6 4.4"
    />
  </g>
</svg>
