<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Filter
  Filter: a funnel with a solid mouth, so the narrowing is read from the top
  down rather than as a plain V.
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
    transform="translate(-2.047 -4.379) scale(1.1706)"
    stroke-width={cioStrokeWidth(weight, 1.1706)}
  >
    <path d="M4.6 6.4 12 14.4l7.4-8" /><path d="M12 14.4v5.4l-3.4 2v-7.4" /><rect
      x="4.4"
      y="4.6"
      width="15.2"
      height="2.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
