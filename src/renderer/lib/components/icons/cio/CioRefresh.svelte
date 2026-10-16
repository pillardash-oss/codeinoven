<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Refresh
  Refresh: one ring made of two arcs, each carrying its own corner, so the
  mark reads as a cycle. A single arc with one corner is the redo mark, and
  the two were the same drawing until this one took the second head.
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
    transform="translate(-1.496 -1.496) scale(1.1246)"
    stroke-width={cioStrokeWidth(weight, 1.1246)}
  >
    <path d="M19.4 9.6a7.5 7.5 0 0 0-12.8-4.2" /><path d="M4.6 14.4a7.5 7.5 0 0 0 12.8 4.2" /><path
      d="M19.4 4.8v4.8h-4.8"
    /><path d="M4.6 19.2v-4.8h4.8" />
  </g>
</svg>
