<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Pull request closed
  Pull request closed: the pull request with its feed closed by a cross, which
  is a change refused rather than taken.
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
    transform="translate(-2.376 -2.047) scale(1.1706)"
    stroke-width={cioStrokeWidth(weight, 1.1706)}
  >
    <circle cx="6.4" cy="6.4" r="2.6" /><rect
      x="5.4"
      y="9"
      width="2"
      height="8.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle cx="17.4" cy="17.6" r="2.6" /><path d="M17.4 15V9" /><path
      d="M14.6 4.4 20.4 10.2"
    /><path d="M20.4 4.4 14.6 10.2" />
  </g>
</svg>
