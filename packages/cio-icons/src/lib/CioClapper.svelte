<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Video
  Video: an analogue camera, one reel sitting on the body with a lens cone
  opening to the right. Two reels over one body read as a face at 32px, which
  is why there is one, and the cone is what says camera rather than a box with
  a lid.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="square"
  stroke-linejoin="miter"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g transform="translate(-1.654 0.484) scale(1.0670)" stroke-width={cioStrokeWidth(weight, 1.067)}>
    <circle cx="8.8" cy="6.6" r="3.1" /><circle
      cx="8.8"
      cy="6.6"
      r="1.25"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M3.4 17.8v-5.3a2.8 2.8 0 0 1 2.8-2.8h9.2a2.8 2.8 0 0 1 2.8 2.8v5.3Z" /><path
      d="M18.2 12.2 22.2 9.8v7.6l-4-2.4Z"
    />
  </g>
</svg>
