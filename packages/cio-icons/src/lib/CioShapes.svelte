<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Shapes
  Shapes: a triangle and a square across the top with the disc sitting under
  them, so the ink fills the box. The first pass left the disc high on the
  right, which emptied the lower left and made the whole mark lean.
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
    transform="translate(-0.707 -0.355) scale(1.0725)"
    stroke-width={cioStrokeWidth(weight, 1.0725)}
  >
    <path d="M8 3.8 12.8 11.8H3.2Z" /><rect x="13.2" y="3.8" width="8" height="8" rx="0" /><circle
      cx="12"
      cy="17.4"
      r="3.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
