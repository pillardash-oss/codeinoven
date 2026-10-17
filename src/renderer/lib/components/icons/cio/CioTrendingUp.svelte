<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Rising
  Rising: a line that steps down once and then climbs away, closed by a corner
  at its head, which is a direction of travel rather than a column set
  measured.
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
    transform="translate(-1.934 -2.764) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <path d="M3.4 17.6 8.8 12.2l3.6 3.6 7.8-7.8" /><path d="M15 7.4h5.2v5.2" />
  </g>
</svg>
