<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Open elsewhere
  Open elsewhere: a frame with its top right corner escaped and running out of
  the box, which is the whole idea in three strokes.
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
    transform="translate(-2.783 -3.069) scale(1.2235)"
    stroke-width={cioStrokeWidth(weight, 1.2235)}
  >
    <path d="M17.4 14.4v6H4.4v-13h6" /><path d="M13.6 4.6h5.8v5.8" /><path
      d="M19.4 4.6 11.4 12.6"
    />
  </g>
</svg>
