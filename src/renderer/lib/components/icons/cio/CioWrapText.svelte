<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Wrap text
  Wrap text: three rules where the middle one turns back on itself, which is a
  line folding rather than a column set.
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
    transform="translate(-3.512 -4.936) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <path d="M4.4 6h15.2" /><path d="M4.4 11.4h10.4a3.2 3.2 0 0 1 0 6.4H12" /><path
      d="M4.4 18.6h6"
    /><path d="M14.2 15.4 11.8 17.8l2.4 2.4" />
  </g>
</svg>
