<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Method
  Method: two braces around a solid point, which is a call rather than a block
  of code.
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
    transform="translate(-3.157 -3.660) scale(1.2631)"
    stroke-width={cioStrokeWidth(weight, 1.2631)}
  >
    <path
      d="M9.4 4.6a2.4 2.4 0 0 0-2.4 2.4v3a2.4 2.4 0 0 1-2.4 2.4 2.4 2.4 0 0 1 2.4 2.4v3a2.4 2.4 0 0 0 2.4 2.4"
    /><path
      d="M14.6 4.6a2.4 2.4 0 0 1 2.4 2.4v3a2.4 2.4 0 0 0 2.4 2.4 2.4 2.4 0 0 0-2.4 2.4v3a2.4 2.4 0 0 1-2.4 2.4"
    /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </g>
</svg>
