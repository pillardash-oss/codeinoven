<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Git tab
  Git: two commits on a stem and the branch that leaves from one of them, the
  head commit solid. The solid head is what makes it a branch rather than
  three dots.
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
    transform="translate(-2.540 -3.146) scale(1.2622)"
    stroke-width={cioStrokeWidth(weight, 1.2622)}
  >
    <circle cx="7" cy="6.4" r="2.4" /><circle cx="7" cy="17.6" r="2.4" /><circle
      cx="17"
      cy="9.6"
      r="2.4"
      fill="currentColor"
      stroke="none"
    /><path d="M7 8.8v6.4" /><path d="M14.8 9.6h-3.6a4.2 4.2 0 0 0-4.2 4.2v1.4" />
  </g>
</svg>
