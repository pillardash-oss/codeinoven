<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Project
  Project: a folder, which is what a project is.
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
    transform="translate(-2.023 -2.201) scale(1.1686)"
    stroke-width={cioStrokeWidth(weight, 1.1686)}
  >
    <path
      d="M3.5 16.7V7.6a2 2 0 0 1 2-2h3.7l2.2 2.8h7.1a2 2 0 0 1 2 2v6.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2Z"
    /> <rect x="6.6" y="10.6" width="7" height="4.4" rx="1" fill="currentColor" stroke="none" />
  </g>
</svg>
