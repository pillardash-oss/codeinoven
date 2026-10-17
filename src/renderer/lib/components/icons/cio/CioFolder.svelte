<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Folder
  Folder: the container with its tab inked, so the mark has one solid mass and
  its direction reads from the top left. The first drawing carried a bar
  floating inside the body with uneven margins above and below it, which is
  what made it look unmade.
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
    transform="translate(-2.022 -2.022) scale(1.1214)"
    stroke-width={cioStrokeWidth(weight, 1.1214)}
  >
    <path
      d="M3.6 17.8V7.2a1.8 1.8 0 0 1 1.8-1.8h3.5l2.2 2.8h8.5a1.8 1.8 0 0 1 1.8 1.8v7.8a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8Z"
    /><rect x="3.4" y="5.3" width="8.4" height="2.6" rx="1.7" fill="currentColor" stroke="none" />
  </g>
</svg>
