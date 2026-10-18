<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Copy
  Copy: a sheet over a sheet, the front one carrying a solid line so the two
  do not read as one thick frame.
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
    transform="translate(-2.963 -2.482) scale(1.2068)"
    stroke-width={cioStrokeWidth(weight, 1.2068)}
  >
    <path d="M4.6 8.4v9.8a2 2 0 0 0 2 2h9.8" /><rect
      x="8.6"
      y="3.8"
      width="11.6"
      height="11.6"
      rx="0"
    /><rect
      x="11"
      y="7.8"
      width="6.8"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
