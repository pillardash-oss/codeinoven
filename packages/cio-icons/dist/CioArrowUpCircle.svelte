<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Send in a ring
  Send in a ring: the send arrow held in a ring, because the surface it sits
  on moves something out rather than up.
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
    transform="translate(-2.482 -2.482) scale(1.2068)"
    stroke-width={cioStrokeWidth(weight, 1.2068)}
  >
    <circle cx="12" cy="12" r="8.2" /><path d="M12 16.6V8.2" /><path d="M8.6 11.4 12 8l3.4 3.4" />
  </g>
</svg>
