<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Expand all
  Expand all: two chevrons stacked, which is a whole list opening rather than
  one row.
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
    transform="translate(-7.183 -7.183) scale(1.5985)"
    stroke-width={cioStrokeWidth(weight, 1.5985)}
  >
    <path d="M6.8 6.4 12 11.6l5.2-5.2" /><path d="M6.8 12.4 12 17.6l5.2-5.2" />
  </g>
</svg>
