<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Light
  Light: a disc with eight even rays, the pair of the crescent.
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
    transform="translate(-1.056 -1.056) scale(1.0880)"
    stroke-width={cioStrokeWidth(weight, 1.088)}
  >
    <circle cx="12" cy="12" r="4.4" /><path d="M12 2.8v2.4" /><path d="M12 18.8v2.4" /><path
      d="M2.8 12h2.4"
    /><path d="M18.8 12h2.4" /><path d="M5.5 5.5 7.2 7.2" /><path d="M16.8 16.8 18.5 18.5" /><path
      d="M18.5 5.5 16.8 7.2"
    /><path d="M7.2 16.8 5.5 18.5" />
  </g>
</svg>
