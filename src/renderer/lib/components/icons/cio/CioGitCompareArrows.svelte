<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Compare across
  Compare across: the two panes with arrows passing between them, which is a
  comparison that moves a change from one side to the other.
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
    transform="translate(-1.870 -1.870) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <rect x="3.4" y="4.6" width="6.2" height="14.8" rx="1.8" /><rect
      x="14.4"
      y="4.6"
      width="6.2"
      height="14.8"
      rx="1.8"
    /><path d="M10 9.6h4" /><path d="M12.2 7.8 14 9.6l-1.8 1.8" /><path d="M14 14.4h-4" /><path
      d="M11.8 12.6 10 14.4l1.8 1.8"
    />
  </g>
</svg>
