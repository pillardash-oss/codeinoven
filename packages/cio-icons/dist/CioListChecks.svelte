<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Checklist
  Checklist: three rungs on a spine, the top one a check, which is a list of
  work with something already done.
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
    transform="translate(-5.328 -4.223) scale(1.4083)"
    stroke-width={cioStrokeWidth(weight, 1.4083)}
  >
    <path d="M5.4 6.4v11.2" /><path d="M8.8 7.6 10.8 9.6 14.6 5.8" /><path
      d="M8.8 13.2h10.4"
    /><path d="M8.8 17.6h7" />
  </g>
</svg>
