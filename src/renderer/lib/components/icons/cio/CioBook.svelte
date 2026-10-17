<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Guide
  Guide: an open book with a solid spine band, which is a reference rather
  than a document.
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
    transform="translate(-3.512 -4.027) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <path
      d="M4.6 4.8h4.6a3 3 0 0 1 2.8 1.8 3 3 0 0 1 2.8-1.8h4.6v13.4h-4.6a3 3 0 0 0-2.8 1.8 3 3 0 0 0-2.8-1.8H4.6Z"
    /><rect x="11.1" y="8" width="1.8" height="8.4" rx="0.9" fill="currentColor" stroke="none" />
  </g>
</svg>
