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
  stroke-linecap="square"
  stroke-linejoin="miter"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-7.966 -7.966) scale(1.6638)"
    stroke-width={cioStrokeWidth(weight, 1.6638)}
  >
    <rect
      x="8.4"
      y="5.4"
      width="2.6"
      height="13.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="13"
      y="5.4"
      width="2.6"
      height="13.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
