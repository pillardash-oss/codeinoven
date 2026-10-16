<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Notes
  Notes: a sticky note, which is what the feature is. The sheet is square, its
  lower right corner peels forward, and one line is solid. A plain rectangle
  with lines on it is a document, not a note you stick somewhere.
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
    transform="translate(-2.487 -2.487) scale(1.2072)"
    stroke-width={cioStrokeWidth(weight, 1.2072)}
  >
    <path
      d="M5.4 4.6h13.2a1.8 1.8 0 0 1 1.8 1.8v8.4l-4.4 4.6H5.4a1.8 1.8 0 0 1-1.8-1.8V6.4a1.8 1.8 0 0 1 1.8-1.8Z"
    /><path d="M20.4 14.8h-2.8a1.6 1.6 0 0 0-1.6 1.6v3" /><rect
      x="7.2"
      y="9.2"
      width="8.8"
      height="2.6"
      rx="1.3"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
