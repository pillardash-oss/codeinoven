<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Verified person
  Verified person: the account with a check beside its head, so the mark
  carries the same acceptance every other check carries.
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
    transform="translate(-1.708 -0.738) scale(1.0891)"
    stroke-width={cioStrokeWidth(weight, 1.0891)}
  >
    <circle cx="9.4" cy="7" r="4" /><path d="M3.4 20.4a6 6 0 0 1 12 0" /><path
      d="M14.8 6.6 17 8.8 21.4 4.2"
    />
  </g>
</svg>
