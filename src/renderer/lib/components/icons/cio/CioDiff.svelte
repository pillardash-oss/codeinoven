<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Changes
  Changes: a page carrying a solid plus. The plus is two crossed solid bars
  rather than a stroked cross, because a stroked cross at 16px reads as a
  tick.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-0.729 -4.899) scale(1.2616)"
    stroke-width={cioStrokeWidth(weight, 1.2616)}
  >
    <path
      d="M4.6 5.4h8.6l4.6 4.6v9.2a2.2 2.2 0 0 1-2.2 2.2H4.6a2.2 2.2 0 0 1-2.2-2.2V7.6a2.2 2.2 0 0 1 2.2-2.2Z"
    /><rect
      x="6.4"
      y="12.8"
      width="8"
      height="2.4"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><rect x="9.2" y="10" width="2.4" height="8" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
