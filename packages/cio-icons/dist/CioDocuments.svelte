<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Files
  Files: two pages, the front one folded at its corner and the back one
  showing behind, which is a set of documents rather than the workspace tree
  the folder mark owns.
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
    transform="translate(-2.311 -3.309) scale(1.2348)"
    stroke-width={cioStrokeWidth(weight, 1.2348)}
  >
    <path
      d="M8.6 4.4h5.6l4.4 4.4v9.4a1.6 1.6 0 0 1-1.6 1.6H8.6a1.6 1.6 0 0 1-1.6-1.6V6a1.6 1.6 0 0 1 1.6-1.6Z"
    /><path d="M14.2 4.4v4.4h4.4" /><path d="M4.6 7.6v10.4a2.4 2.4 0 0 0 2.4 2.4h7.4" />
  </g>
</svg>
