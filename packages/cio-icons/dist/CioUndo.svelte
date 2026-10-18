<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Undo
  Undo: a ring broken by a corner on the left, the mirror of refresh, which is
  how the two are told apart at 12px.
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
    transform="translate(-3.465 -3.495) scale(1.2887)"
    stroke-width={cioStrokeWidth(weight, 1.2887)}
  >
    <path d="M4.4 12a7.6 7.6 0 1 0 2.3-5.4" /><path d="M4.4 4.4v4.4h4.4" />
  </g>
</svg>
