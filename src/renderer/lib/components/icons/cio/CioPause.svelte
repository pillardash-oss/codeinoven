<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Pause
  Pause: two solid bars carrying the same mass as the play triangle, so the
  two read as one control.
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
    transform="translate(-8.507 -8.507) scale(1.7089)"
    stroke-width={cioStrokeWidth(weight, 1.7089)}
  >
    <rect
      x="8.4"
      y="5.4"
      width="2.6"
      height="13.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><rect x="13" y="5.4" width="2.6" height="13.2" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
