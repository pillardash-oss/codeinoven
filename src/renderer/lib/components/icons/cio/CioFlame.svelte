<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Credits
  Credits: a flame with a solid core, which is a budget being burned rather
  than a warning to read.
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
    transform="translate(-4.592 -2.453) scale(1.3827)"
    stroke-width={cioStrokeWidth(weight, 1.3827)}
  >
    <path d="M12 3.4c2.9 2.7 5.4 5.1 5.4 8.7a5.4 5.4 0 0 1-10.8 0c0-2 1-3.4 2.2-4.8" /><circle
      cx="12"
      cy="14.4"
      r="2.4"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
