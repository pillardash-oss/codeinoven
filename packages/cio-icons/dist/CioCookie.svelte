<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Cookies
  Cookies: a disc with bitten edges and a few solid chips, which is a site
  storing something rather than a plain setting.
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
    transform="translate(-2.169 -2.169) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4 4.2 4.2 0 0 1-4.2-4.2A4.2 4.2 0 0 1 12 3.6Z" /><circle
      cx="9.4"
      cy="9.6"
      r="1.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle
      cx="13.6"
      cy="13.4"
      r="1.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle cx="9" cy="15" r="1.4" stroke="none" style="fill: var(--icon-anchor, currentColor)" />
  </g>
</svg>
