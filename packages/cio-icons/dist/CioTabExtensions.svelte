<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Extensions tab
  Extensions: a puzzle piece, one knob cut into the top edge and one knob
  solid on the right. The previous drawing was a square with a single knob and
  it read as a clipboard, which is reserved for the copy toast.
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
    transform="translate(-3.561 1.207) scale(1.1658)"
    stroke-width={cioStrokeWidth(weight, 1.1658)}
  >
    <path d="M6.4 5.2h3.2a3 3 0 1 1 5 0h3.2v12.4H6.4Z" /><circle
      cx="18.4"
      cy="11.4"
      r="2.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
