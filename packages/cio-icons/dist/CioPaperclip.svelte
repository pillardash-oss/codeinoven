<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Attach
  Attach: one continuous wire folded four times, which is the whole shape of a
  paperclip.
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
    transform="translate(-1.757 -2.997) scale(1.2901)"
    stroke-width={cioStrokeWidth(weight, 1.2901)}
  >
    <path
      d="M17.4 11.4 10.8 18a4.2 4.2 0 0 1-6-6l7.4-7.4a3 3 0 0 1 4.2 4.2l-7.2 7.2a1.6 1.6 0 0 1-2.2-2.2l6.4-6.4"
    />
  </g>
</svg>
