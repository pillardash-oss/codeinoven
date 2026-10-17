<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Add to folder
  Add to folder: the plain folder with a solid arrow entering it from the
  right, head first, which is a file being taken in. The first drawing had the
  arrow leaving the folder over a second tray line, so it read as exporting
  and carried detail that said nothing.
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
    transform="translate(-2.107 -2.390) scale(1.1508)"
    stroke-width={cioStrokeWidth(weight, 1.1508)}
  >
    <path
      d="M3.6 17.6V7.4a1.6 1.6 0 0 1 1.6-1.6h3.4l2.2 2.8h8.4a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6Z"
    /><path d="M17.2 10.2 13.6 13.8l3.6 3.6" /><rect
      x="15.2"
      y="12.7"
      width="6.6"
      height="2.2"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
