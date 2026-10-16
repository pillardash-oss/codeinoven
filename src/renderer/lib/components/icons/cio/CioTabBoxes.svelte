<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Containers
  Containers: a crate seen from the front, a lid rule across it and two straps
  running the full height of the body. The first drawing was a square with a
  smaller square inside, which is the silhouette the scoped field wears, so
  the two were unreadable apart at 12px. The straps first stopped short of
  both edges and read as two loose bars in a box.
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
    transform="translate(-2.487 -3.944) scale(1.2072)"
    stroke-width={cioStrokeWidth(weight, 1.2072)}
  >
    <path d="M3.6 8.6h16.8v9.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2Z" /><path
      d="M3.6 8.6a2 2 0 0 1 2-2h12.8a2 2 0 0 1 2 2"
    /><rect x="8.2" y="8.6" width="2" height="11.2" rx="1" fill="currentColor" stroke="none" /><rect
      x="13.8"
      y="8.6"
      width="2"
      height="11.2"
      rx="1"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
