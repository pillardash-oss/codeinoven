<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Subagent
  Subagent: a head with an aerial and two solid eyes. The eyes carry the mass;
  one wider solid visor was tried and read as a robot mask rather than a
  worker.
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
    transform="translate(-2.169 -1.463) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <rect x="4.2" y="8.6" width="15.6" height="11.2" rx="0" /><path d="M12 8.6V5.4" /><circle
      cx="12"
      cy="3.8"
      r="1.7"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="7.6"
      y="12.6"
      width="3.2"
      height="3.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="13.2"
      y="12.6"
      width="3.2"
      height="3.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
