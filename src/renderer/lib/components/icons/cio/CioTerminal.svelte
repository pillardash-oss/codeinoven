<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Oven and terminal
  Oven and terminal: a frame with a prompt and a solid cursor. The cursor is
  the anchor, and it is 2.4 units tall so it survives 12px as well as 16px.
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
    transform="translate(-1.870 -1.870) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4" /><path
      d="M7.6 9.4 10.4 12.2 7.6 15"
    /><rect x="12" y="12.6" width="5.2" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
  </g>
</svg>
