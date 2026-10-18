<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Slow
  Slow: a shell with the creature under it. A clock says what time it is and a
  spanner says a setting; the snail is the only mark that says a thing is
  taking too long.
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
    transform="translate(-2.393 -2.763) scale(1.2623)"
    stroke-width={cioStrokeWidth(weight, 1.2623)}
  >
    <circle cx="10.4" cy="11.4" r="5.4" /><circle
      cx="10.4"
      cy="11.4"
      r="1.5"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M3.6 17.4h15.6" /><path d="M16.8 17.4v-3.6" /><circle
      cx="16.8"
      cy="12.6"
      r="1.5"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M18.6 10.8 16.8 12.6" />
  </g>
</svg>
