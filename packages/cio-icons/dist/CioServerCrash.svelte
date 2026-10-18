<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Server down
  Server down: the bays with their lamps and a close struck into the lower
  one, the close drawn as two solid bars so it reads at the size the mark is
  used at. Two strokes were too thin to say it.
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
    transform="translate(-1.870 -1.870) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <rect x="3.4" y="4.4" width="17.2" height="6.4" rx="0" /><circle
      cx="7.4"
      cy="7.6"
      r="1.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect x="3.4" y="13.2" width="17.2" height="6.4" rx="0" /><circle
      cx="7.4"
      cy="16.4"
      r="1.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><g transform="rotate(45 17.4 16.4)"
      ><rect
        x="14.9"
        y="15.3"
        width="5"
        height="2.2"
        stroke="none"
        style="fill: var(--icon-anchor, currentColor)"
      /></g
    ><g transform="rotate(-45 17.4 16.4)"
      ><rect
        x="14.9"
        y="15.3"
        width="5"
        height="2.2"
        stroke="none"
        style="fill: var(--icon-anchor, currentColor)"
      /></g
    >
  </g>
</svg>
