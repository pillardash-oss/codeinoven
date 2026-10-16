<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Reorder
  Reorder: six solid dots in two columns. Nothing else reads as a handle at
  12px.
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
    transform="translate(-8.924 -8.924) scale(1.7437)"
    stroke-width={cioStrokeWidth(weight, 1.7437)}
  >
    <circle cx="9.4" cy="7" r="1.3" fill="currentColor" stroke="none" /><circle
      cx="14.6"
      cy="7"
      r="1.3"
      fill="currentColor"
      stroke="none"
    /><circle cx="9.4" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle
      cx="14.6"
      cy="12"
      r="1.3"
      fill="currentColor"
      stroke="none"
    /><circle cx="9.4" cy="17" r="1.3" fill="currentColor" stroke="none" /><circle
      cx="14.6"
      cy="17"
      r="1.3"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
