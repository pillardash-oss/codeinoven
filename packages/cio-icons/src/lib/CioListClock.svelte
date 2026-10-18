<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · List with a clock
  List with a clock: the list holding a small clock, which is a list that runs
  on a timer.
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
    transform="translate(-2.084 -3.345) scale(1.1446)"
    stroke-width={cioStrokeWidth(weight, 1.1446)}
  >
    <path d="M3.6 6.6h16.8" /><path d="M3.6 11.8h6.4" /><path d="M3.6 17h6.4" /><circle
      cx="16.4"
      cy="15.6"
      r="4.6"
    /><circle
      cx="16.4"
      cy="15.6"
      r="1.1"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M16.4 13.6v2" /><path d="M16.4 15.6h1.8" />
  </g>
</svg>
