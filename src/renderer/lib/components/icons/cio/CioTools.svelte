<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Tools
  Tools: a socket spanner. This is the spec studio toggle, so it has to read
  as engineering work rather than as an office. The case Lucide draws is a box
  with a handle on it, which is what luggage looks like.
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
    transform="translate(-3.057 1.138) scale(1.2342)"
    stroke-width={cioStrokeWidth(weight, 1.2342)}
  >
    <path d="M20.2 5.6 17.9 9.6H13.3L11 5.6l2.3-4h4.6Z" /><circle
      cx="15.6"
      cy="5.6"
      r="1.9"
      fill="currentColor"
      stroke="none"
    /><path d="M10.7 7.1 13.1 9.5 5.7 16.9 3.3 14.5Z" fill="currentColor" stroke="none" />
  </g>
</svg>
