<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Release
  Release: a body with solid fins and a solid eye, which is a launch rather
  than a plain arrow.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-2.482 -2.242) scale(1.2069)"
    stroke-width={cioStrokeWidth(weight, 1.2069)}
  >
    <path d="M12 3.6c3.2 2.4 5 5.8 5 9.6l-2.4 2.8H9.4L7 13.2c0-3.8 1.8-7.2 5-9.6Z" /><circle
      cx="12"
      cy="9.6"
      r="1.9"
      fill="currentColor"
      stroke="none"
    /><path d="M9.4 16 7.6 20M14.6 16l1.8 4" />
  </g>
</svg>
