<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Select an area
  Select an area: a dashed box with the pointer at its corner, because a solid
  box would be the square mark.
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
    transform="translate(-3.417 -3.478) scale(1.2848)"
    stroke-width={cioStrokeWidth(weight, 1.2848)}
  >
    <path d="M4.4 4.4h3.2" /><path d="M10.4 4.4h3.2" /><path d="M16.4 4.4h3.2" /><path
      d="M19.6 7.4v3.2"
    /><path d="M19.6 13.4v3.2" /><path d="M4.4 7.4v3.2" /><path d="M4.4 13.4v3.2" /><path
      d="M16.4 19.6h3.2"
    /><path d="M10.4 19.6h3.2" /><path d="M4.4 19.6h3.2" /><path
      d="M8.6 8.6 18.4 15l-4.6 1-2 4.6Z"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
