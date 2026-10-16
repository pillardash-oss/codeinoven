<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Key
  Key: a ring with a solid bore and a shaft with two teeth, so the shaft is
  not taken for a line of text.
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
    transform="translate(-2.653 -3.660) scale(1.2631)"
    stroke-width={cioStrokeWidth(weight, 1.2631)}
  >
    <circle cx="8" cy="16" r="4.2" /><circle
      cx="8"
      cy="16"
      r="1.5"
      fill="currentColor"
      stroke="none"
    /><path d="M11 13 19.4 4.6" /><path d="M16.4 7.6 18.6 9.8" /><path d="M14 10 16.2 12.2" />
  </g>
</svg>
