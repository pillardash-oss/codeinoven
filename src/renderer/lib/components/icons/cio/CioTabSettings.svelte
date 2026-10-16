<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Settings
  Settings: two sliders, each handle solid, its track entering from both
  sides. The gap in the track is what stops the handle merging into it at
  16px, which is exactly what happened in pass C. The gap is 1.6 units, which
  is just over one device pixel at rail size; a 1.2-unit gap vanished and the
  glyph became two plain bars.
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
    transform="translate(-2.5263 -2.5263) scale(1.2105)"
    stroke-width={cioStrokeWidth(weight, 1.2105)}
  >
    <path d="M3.5 8.6h2.9" /> <path d="M15 8.6h5.5" />
    <rect x="8" y="6.9" width="5.4" height="3.4" rx="1.2" fill="currentColor" stroke="none" />
    <path d="M3.5 15.4h5.5" /> <path d="M17.6 15.4h2.9" />
    <rect x="10.6" y="13.7" width="5.4" height="3.4" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
