<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Fork
  Fork: one solid node above two, joined by short stems. Three solid nodes
  read as a fork at 12px where outlines do not.
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
    transform="translate(-6.067 -5.467) scale(1.5055)"
    stroke-width={cioStrokeWidth(weight, 1.5055)}
  >
    <g transform="rotate(180 12 12)"
      ><rect
        x="10.7"
        y="5.1"
        width="2.6"
        height="2.6"
        rx="0"
        fill="currentColor"
        stroke="none"
      /><rect
        x="5.3"
        y="17.1"
        width="2.6"
        height="2.6"
        rx="0"
        fill="currentColor"
        stroke="none"
      /><rect
        x="16.1"
        y="17.1"
        width="2.6"
        height="2.6"
        rx="0"
        fill="currentColor"
        stroke="none"
      /><path d="M12 9v1.4a3.4 3.4 0 0 1-3.4 3.4h-.4" /><path
        d="M12 10.4a3.4 3.4 0 0 0 3.4 3.4h.4"
      /></g
    >
  </g>
</svg>
