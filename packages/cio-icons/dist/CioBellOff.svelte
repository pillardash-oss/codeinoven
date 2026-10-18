<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Muted
  Muted: the bell struck through, the bell kept whole underneath so it still
  reads as the bell turned off.
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
    transform="translate(-2.855 -2.855) scale(1.2379)"
    stroke-width={cioStrokeWidth(weight, 1.2379)}
  >
    <path d="M6.4 16.4v-5a5.6 5.6 0 0 1 11.2 0v5" /><path d="M4.6 16.4h14.8" /><path
      d="M12 5.8V4.2"
    /><path d="M4.4 19.6 19.6 4.4" />
  </g>
</svg>
