<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Sound off
  Sound off: the same speaker with the waves replaced by a cross, so the two
  are one control in two states.
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
    transform="translate(-3.893 -3.139) scale(1.2616)"
    stroke-width={cioStrokeWidth(weight, 1.2616)}
  >
    <path d="M4.6 9.4h3.6L12.8 5.4v13.2l-4.6-4H4.6Z" /><rect
      x="6.2"
      y="10.4"
      width="3"
      height="3.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><path d="M16.2 9.8 20.6 14.2" /><path d="M20.6 9.8 16.2 14.2" />
  </g>
</svg>
