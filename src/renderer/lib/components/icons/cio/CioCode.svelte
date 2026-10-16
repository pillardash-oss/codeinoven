<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Code
  Code: two chevrons with a slash between them, which is what tells code from
  a plain direction.
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
    transform="translate(-3.888 -3.888) scale(1.3240)"
    stroke-width={cioStrokeWidth(weight, 1.324)}
  >
    <path d="M8.4 8.4 4.6 12l3.8 3.6" /><path d="M15.6 8.4 19.4 12l-3.8 3.6" /><path
      d="M13.4 6.4 10.6 17.6"
    />
  </g>
</svg>
