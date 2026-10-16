<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Merge
  Merge: a line joining another at a solid node, the counterpart of the pull
  request arrow.
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
    transform="translate(-2.693 -2.950) scale(1.2860)"
    stroke-width={cioStrokeWidth(weight, 1.286)}
  >
    <circle cx="6.6" cy="6.4" r="2.6" /><rect
      x="5.6"
      y="9"
      width="2"
      height="8.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><path d="M17.4 6.4v3.2a4.2 4.2 0 0 1-4.2 4.2H10.6" /><path
      d="M12.8 11.2 10.2 13.8l2.6 2.6"
    /><circle cx="17.4" cy="18" r="2.4" fill="currentColor" stroke="none" />
  </g>
</svg>
