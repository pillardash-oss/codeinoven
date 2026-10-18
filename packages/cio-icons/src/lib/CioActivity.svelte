<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Activity
  Activity: one line that rises, dips and recovers, which is a heartbeat
  rather than a chart. A column set said "a measure"; the trace says "a thing
  still alive".
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="square"
  stroke-linejoin="miter"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-1.870 -1.925) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <path d="M3.4 12.4h3.4l2.2-6.6 3.2 12.4 2.6-8.2h5.8" />
  </g>
</svg>
