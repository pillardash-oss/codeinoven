<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Notifications
  Notifications: a bell with a solid mouth bar and a clapper. The bar is the
  anchor; a thin rim there disappeared into the body at 16px.
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
    transform="translate(-2.876 -5.317) scale(1.2397)"
    stroke-width={cioStrokeWidth(weight, 1.2397)}
  >
    <path d="M7 16.4V11a5 5 0 0 1 10 0v5.4" /><rect
      x="4.4"
      y="16.4"
      width="15.2"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M10.2 21a2.2 2.2 0 0 0 3.6 0" />
  </g>
</svg>
