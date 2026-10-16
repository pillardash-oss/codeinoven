<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Run
  Run: the return arrow, on the indicator box with the other direction marks,
  for the key that runs what a palette row says.
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
    transform="translate(0.759 -0.183) scale(0.9451)"
    stroke-width={cioStrokeWidth(weight, 0.9451)}
  >
    <path d="M18.4 5.4v8.4a2.8 2.8 0 0 1-2.8 2.8H5.6" /><path d="M9.6 12.8 5.4 16.6l4.2 3.8" />
  </g>
</svg>
