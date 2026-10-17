<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Repository
  Repository: the folder with a branch mark inside it, which is a checkout
  rather than a directory.
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
    transform="translate(-2.169 -2.653) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <path
      d="M3.6 17.6V7.2a1.8 1.8 0 0 1 1.8-1.8h4l2.2 2.8h7a1.8 1.8 0 0 1 1.8 1.8v7.6a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8Z"
    /><circle cx="9.4" cy="11.6" r="1.8" /><rect
      x="8.5"
      y="13.4"
      width="1.8"
      height="3.4"
      rx="0.9"
      fill="currentColor"
      stroke="none"
    /><circle cx="15.4" cy="15" r="1.8" /><path d="M15.4 13.2v-1" /><path
      d="M11.2 11.6h2.4a1.8 1.8 0 0 1 1.8 1.8v1.6"
    />
  </g>
</svg>
