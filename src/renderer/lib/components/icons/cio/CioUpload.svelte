<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Upload
  Upload: the download turned over, with the same solid shaft so the two read
  as one gesture in two directions.
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
    transform="translate(-2.977 -3.855) scale(1.2481)"
    stroke-width={cioStrokeWidth(weight, 1.2481)}
  >
    <rect
      x="10.9"
      y="8.4"
      width="2.2"
      height="7.6"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M7.4 9.4 12 4.8l4.6 4.6" /><path
      d="M4.4 18.4v.8a1.4 1.4 0 0 0 1.4 1.4h12.4a1.4 1.4 0 0 0 1.4-1.4v-.8"
    />
  </g>
</svg>
