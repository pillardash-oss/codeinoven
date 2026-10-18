<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Add a date
  Add a date: the calendar with a plus in the day area, the plus solid the way
  every other plus in the set is.
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
    transform="translate(-1.870 -1.870) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <rect x="3.4" y="5.4" width="17.2" height="15.2" rx="0" /><rect
      x="3.4"
      y="5.4"
      width="17.2"
      height="4.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M8.2 3.4v4" /><path d="M15.8 3.4v4" /><rect
      x="11"
      y="11.6"
      width="2"
      height="7"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="8.5"
      y="14.1"
      width="7"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
