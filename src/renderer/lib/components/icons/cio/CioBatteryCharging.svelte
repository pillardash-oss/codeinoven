<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Charging
  Charging: a cell with a bolt in it, the bolt solid so it survives the
  smallest size a gauge is drawn at.
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
    transform="translate(-1.755 -1.313) scale(1.1094)"
    stroke-width={cioStrokeWidth(weight, 1.1094)}
  >
    <rect x="3.4" y="7.4" width="15.6" height="9.2" rx="2" /><path d="M21.4 10.6v2.8" /><path
      d="M12.4 8.8 8.8 13h3l-.8 3 3.6-4.4h-3Z"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
