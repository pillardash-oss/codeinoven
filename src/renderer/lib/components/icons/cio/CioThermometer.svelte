<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Heat
  Heat: a stem into a bulb, the bulb solid, which is load rather than a
  measure of time.
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
    transform="translate(0.530 -0.974) scale(1.0434)"
    stroke-width={cioStrokeWidth(weight, 1.0434)}
  >
    <path d="M13.8 13.8V5.6a2.8 2.8 0 0 0-5.6 0v8.2a4.6 4.6 0 1 0 5.6 0Z" /><circle
      cx="11"
      cy="16.4"
      r="1.9"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
