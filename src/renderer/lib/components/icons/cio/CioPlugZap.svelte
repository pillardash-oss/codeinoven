<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Powered
  Powered: the plug with a bolt beside it, which is a connection that carries
  energy rather than one that is merely made.
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
  <g
    transform="translate(-2.128 -2.305) scale(1.1626)"
    stroke-width={cioStrokeWidth(weight, 1.1626)}
  >
    <rect x="6.6" y="4.4" width="2" height="4.4" rx="0" /><rect
      x="9.8"
      y="4.4"
      width="2"
      height="4.4"
      rx="0"
    /><rect x="3.6" y="8.8" width="11.2" height="6.4" rx="0" /><path d="M9.2 15.2v5" /><path
      d="M20.4 4.6 16.2 10.8h3.2l-2.4 6.2 4.6-6.6h-3.2Z"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
