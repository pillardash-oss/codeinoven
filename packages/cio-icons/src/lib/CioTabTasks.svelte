<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Task manager
  Task manager: two running panels, one behind the other, the front one lit.
  Isometric planes and lanes were both tried first and both failed at 16px:
  the planes closed into a single downward point, and the lanes read as a
  list, which is what Thread already is. The panels overlap by 2 units so the
  offset is a visible step rather than two tiles touching.
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
  <g transform="translate(-1.744 -0.846) scale(1.1700)" stroke-width={cioStrokeWidth(weight, 1.17)}>
    <rect x="7.8" y="3.8" width="12.7" height="7.8" rx="0" />
    <rect
      x="3.5"
      y="9.6"
      width="12.7"
      height="8.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
