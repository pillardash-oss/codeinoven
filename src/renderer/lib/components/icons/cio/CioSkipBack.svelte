<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Skip back
  Skip back: the skip mark mirrored, its bar on the left, so the pair reads as
  one transport either way.
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
    transform="translate(-10.359 -10.736) scale(1.8947)"
    stroke-width={cioStrokeWidth(weight, 1.8947)}
  >
    <rect x="6" y="6.4" width="2.4" height="11.2" rx="1.2" fill="currentColor" stroke="none" /><path
      d="M17.6 6.4 10 12l7.6 5.6Z"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
