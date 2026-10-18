<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Search
  Search: a lens with a solid pupil and a handle thick enough to carry the
  mass at 16px. An empty lens read as a plain ring.
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
    transform="translate(-2.929 -2.929) scale(1.1962)"
    stroke-width={cioStrokeWidth(weight, 1.1962)}
  >
    <circle cx="10.4" cy="10.4" r="6.2" /><path d="M15.2 15.2 20.4 20.4" /><circle
      cx="10.4"
      cy="10.4"
      r="2.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
