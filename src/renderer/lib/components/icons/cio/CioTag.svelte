<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Tag
  Tag: a label with its corner cut and a solid eyelet, which is what makes a
  tag read as tied on.
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
    transform="translate(-3.512 -3.512) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <path d="M4.4 10.8V6a1.6 1.6 0 0 1 1.6-1.6h4.8l8.8 8.8-6.4 6.4Z" /><circle
      cx="8.4"
      cy="8.4"
      r="1.9"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
