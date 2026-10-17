<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Maximise
  Maximise: four corners opening outward, drawn as corners rather than arrows
  so it never reads as a drag handle.
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
    transform="translate(-3.888 -3.888) scale(1.3240)"
    stroke-width={cioStrokeWidth(weight, 1.324)}
  >
    <path d="M9.4 4.6H6a1.4 1.4 0 0 0-1.4 1.4v3.4" /><path
      d="M14.6 4.6H18a1.4 1.4 0 0 1 1.4 1.4v3.4"
    /><path d="M19.4 14.6v3.4a1.4 1.4 0 0 1-1.4 1.4h-3.4" /><path
      d="M4.6 14.6v3.4a1.4 1.4 0 0 0 1.4 1.4h3.4"
    />
  </g>
</svg>
