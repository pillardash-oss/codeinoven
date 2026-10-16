<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Variable
  Variable: a slot carrying a cross, which is the mark for a value the action
  leaves open.
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
    transform="translate(-2.189 -2.189) scale(1.1824)"
    stroke-width={cioStrokeWidth(weight, 1.1824)}
  >
    <rect x="3.4" y="6.2" width="17.2" height="11.6" rx="2.2" /><path d="M9.6 9.8 14.4 14.2" /><path
      d="M14.4 9.8 9.6 14.2"
    />
  </g>
</svg>
