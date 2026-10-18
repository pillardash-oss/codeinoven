<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Sign in
  Sign in: a doorway with the arrow entering it, which is a session starting.
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
    transform="translate(-3.361 -3.512) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <path d="M13.4 4.4H6.6a2 2 0 0 0-2 2v11.2a2 2 0 0 0 2 2h6.8" /><path d="M18.4 12H9.6" /><path
      d="M14.8 8l4 4-4 4"
    />
  </g>
</svg>
