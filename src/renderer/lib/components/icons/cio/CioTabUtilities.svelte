<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Utilities
  Utilities: four even panels in outline, the grid the Utilities page and the
  model picker's "all models" section both read as.
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
    transform="translate(-2.023 -2.023) scale(1.1686)"
    stroke-width={cioStrokeWidth(weight, 1.1686)}
  >
    <rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1.6" />
    <rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1.6" />
    <rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1.6" />
    <rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1.6" />
  </g>
</svg>
