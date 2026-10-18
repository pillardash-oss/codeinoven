<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Unpin
  Unpin: the pin laid on its side with the stroke through it, which is the pin
  let go rather than a pin absent.
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
    <path d="M8.4 4.6h7.2" /><path d="M9.8 4.6v6.2l-2.4 3.6h9.2l-2.4-3.6V4.6" /><path
      d="M12 14.4v4.8"
    /><path d="M4.4 19.6 19.6 4.4" />
  </g>
</svg>
