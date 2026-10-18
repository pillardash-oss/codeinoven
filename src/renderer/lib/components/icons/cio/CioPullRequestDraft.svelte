<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Pull request draft
  Pull request draft: the pull request with its head node left open, which is
  the same change with nothing put up for review yet. Dashing the ring in
  short strokes, as the first pass did, read as a mistake at 16px.
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
    transform="translate(-2.231 -2.480) scale(1.2481)"
    stroke-width={cioStrokeWidth(weight, 1.2481)}
  >
    <circle cx="6.6" cy="6.4" r="2.6" stroke-dasharray="2.6 2" /><rect
      x="5.6"
      y="9"
      width="2"
      height="8.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M17.4 15.4V12a3.4 3.4 0 0 0-3.4-3.4H10.6" /><path
      d="M13.4 6.2 10.4 8.6l3 2.4"
    /><circle
      cx="17.4"
      cy="18"
      r="2.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
