<script lang="ts">import { cioStrokeWidth } from "./glyph";
let { size = 16, strokeWidth = 1.8, class: className = "", ...rest } = $props();
/** An icon is decoration unless the call site names it for a screen reader. */
let named = $derived(rest.role === "img" || rest["aria-label"] !== undefined);
/** The weight as a number: the prop takes a string the way Lucide's does. */
let weight = $derived(typeof strokeWidth === "number" ? strokeWidth : Number(strokeWidth) || 1.8);
</script>

<!--
  CIO · Memory
  Memory: a head, closed at the chin, holding two solid nodes joined by a
  short line, which is a mind with what it kept wired together. The plates
  before it read as a list or a store and said nothing about whose memory it
  is; a brain outline read as a cloud at 16px, and a first head with a neck
  line read as a lightbulb.
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
    transform="translate(-2.248 -2.429) scale(1.1874)"
    stroke-width={cioStrokeWidth(weight, 1.1874)}
  >
    <path
      d="M12 3.8a7 7 0 0 1 7 7c0 2.2-1 3.6-2 4.8-.8 1-1.2 1.8-1.3 3-.1 1.1-1 1.9-2.1 1.9h-3.2c-1.1 0-2-.8-2.1-1.9-.1-1.2-.5-2-1.3-3-1-1.2-2-2.6-2-4.8a7 7 0 0 1 7-7Z"
    /><circle
      cx="9.4"
      cy="10.6"
      r="1.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle
      cx="14.6"
      cy="10.6"
      r="1.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M11 10.6h2" />
  </g>
</svg>
