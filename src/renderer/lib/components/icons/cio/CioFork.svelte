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
    transform="translate(-3.324 -3.832) scale(1.2770)"
    stroke-width={cioStrokeWidth(weight, 1.277)}
  >
    <circle cx="12" cy="6.4" r="2.6" fill="currentColor" stroke="none" /><circle
      cx="6.6"
      cy="18.4"
      r="2.6"
      fill="currentColor"
      stroke="none"
    /><circle cx="17.4" cy="18.4" r="2.6" fill="currentColor" stroke="none" /><path
      d="M12 9v1.4a3.4 3.4 0 0 1-3.4 3.4h-.4"
    /><path d="M12 10.4a3.4 3.4 0 0 0 3.4 3.4h.4" />
  </g>
</svg>
