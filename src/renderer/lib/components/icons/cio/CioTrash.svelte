<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Delete
  Delete: a bin with a lid rule, a handle and one solid rib. Two ribs turned
  the body into a smudge at 16px; one keeps the ribs reading as ribs.
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
    transform="translate(-2.334 -2.922) scale(1.1945)"
    stroke-width={cioStrokeWidth(weight, 1.1945)}
  >
    <path d="M4.4 7.4h15.2" /><path
      d="M9.6 7.4V5.6a1.4 1.4 0 0 1 1.4-1.4h2a1.4 1.4 0 0 1 1.4 1.4v1.8"
    /><path d="M6.8 7.4 7.8 19a2 2 0 0 0 2 1.8h4.4a2 2 0 0 0 2-1.8l1-11.6" /><rect
      x="11"
      y="10.6"
      width="2"
      height="6.2"
      rx="1"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
