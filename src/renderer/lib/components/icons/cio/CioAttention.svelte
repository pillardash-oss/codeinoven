<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Decisions made for you
  Decisions made for you: a triangle with a solid stem and a solid dot, which
  is a warning without a second outline inside it.
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
    transform="translate(-1.604 -1.378) scale(1.1336)"
    stroke-width={cioStrokeWidth(weight, 1.1336)}
  >
    <path
      d="M10.8 4.6a1.4 1.4 0 0 1 2.4 0l7.4 13a1.4 1.4 0 0 1-1.2 2.1H4.6a1.4 1.4 0 0 1-1.2-2.1Z"
    /><rect x="11" y="9.4" width="2" height="5.2" rx="1" fill="currentColor" stroke="none" /><circle
      cx="12"
      cy="16.8"
      r="1.2"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
