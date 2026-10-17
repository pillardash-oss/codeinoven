<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Select all
  Select all: a frame with everything inside it inked, which is the whole of a
  thing taken rather than a caret sitting in it. The I-beam it was said where
  the cursor goes, not what the command does.
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
    transform="translate(-3.512 -3.512) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <rect x="4.4" y="4.4" width="15.2" height="15.2" rx="2" /><rect
      x="7.2"
      y="7.2"
      width="9.6"
      height="9.6"
      rx="1.4"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
