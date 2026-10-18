<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Erase
  Erase: a block laid on the diagonal with the corner it has already cleared,
  which is rubbing out rather than deleting.
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
    transform="translate(-2.633 -2.897) scale(1.2499)"
    stroke-width={cioStrokeWidth(weight, 1.2499)}
  >
    <path d="M8.6 4.6a2 2 0 0 1 2.8 0l6.6 6.6-6 6H7l-2.6-2.6a2 2 0 0 1 0-2.8Z" /><path
      d="M10.6 19.8h9"
    />
  </g>
</svg>
