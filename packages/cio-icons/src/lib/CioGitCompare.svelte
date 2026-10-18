<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Compare
  Compare: two panes read side by side, each carrying one solid line at a
  different height, which is what makes them two versions rather than two
  files. The crossing arrows said only that two directions exist.
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
    transform="translate(-2.169 -2.169) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <rect x="3.6" y="4.6" width="7.2" height="14.8" rx="0" /><rect
      x="13.2"
      y="4.6"
      width="7.2"
      height="14.8"
      rx="0"
    /><rect
      x="5.6"
      y="8"
      width="3.2"
      height="1.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="15.2"
      y="12.6"
      width="3.2"
      height="1.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
