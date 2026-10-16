<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Document
  Document: a page with a folded corner and two solid lines of text, the
  longer one first.
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
    transform="translate(-2.368 -2.736) scale(1.2080)"
    stroke-width={cioStrokeWidth(weight, 1.208)}
  >
    <path
      d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z"
    /><path d="M13.4 3.8v5.2h5" /><rect
      x="8.4"
      y="11.6"
      width="7.2"
      height="2"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect x="8.4" y="15.2" width="4.6" height="2" rx="1" fill="currentColor" stroke="none" />
  </g>
</svg>
