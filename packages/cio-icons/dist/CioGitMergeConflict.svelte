<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Merge conflict
  Merge conflict: the branch coming down into its node with a close at its
  head, which is the close any version control system draws for it. The merge
  struck out said a join was refused rather than that two lines could not be
  read together.
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
    transform="translate(-1.704 -1.937) scale(1.1706)"
    stroke-width={cioStrokeWidth(weight, 1.1706)}
  >
    <path d="M6.4 11.4v9" /><path d="M8.6 3.8 4.2 8.2" /><path d="M8.6 8.2 4.2 3.8" /><path
      d="M12.4 6h3a2.6 2.6 0 0 1 2.6 2.6v6.6"
    /><circle
      cx="18"
      cy="17.8"
      r="2.5"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
