<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Cloud deployments
  Cloud deployments: a cloud carrying a solid bar, which is the deployment
  payload. A bare cloud read as weather, and an arrow inside it disappeared at
  16px.
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
  <g transform="translate(0.082 0.673) scale(1.0294)" stroke-width={cioStrokeWidth(weight, 1.0294)}>
    <path d="M6.4 17.6h11.2a4 4 0 0 0 .6-7.9 6.2 6.2 0 0 0-12-1.1 3.6 3.6 0 0 0 .2 9Z" /><rect
      x="9.2"
      y="11.4"
      width="5.6"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
