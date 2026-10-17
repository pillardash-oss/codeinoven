<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Saved
  Saved: the ribbon with a check where the tab was, which is a bookmark that
  has landed rather than one held.
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
    transform="translate(-2.977 -3.357) scale(1.2481)"
    stroke-width={cioStrokeWidth(weight, 1.2481)}
  >
    <path
      d="M6.4 4.4h11.2a1.6 1.6 0 0 1 1.6 1.6v14.2l-7.2-4.4-7.2 4.4V6a1.6 1.6 0 0 1 1.6-1.6Z"
    /><path d="M9.2 10.4 11.4 12.6 15.2 8.4" />
  </g>
</svg>
