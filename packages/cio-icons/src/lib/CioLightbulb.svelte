<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Idea
  Idea: a bulb with a solid filament, which is a thought offered rather than a
  sparkle.
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
    transform="translate(-2.993 -2.378) scale(1.2494)"
    stroke-width={cioStrokeWidth(weight, 1.2494)}
  >
    <path
      d="M12 3.6a6 6 0 0 1 3.6 10.8c-.8.6-1.2 1.4-1.3 2.4H9.7c-.1-1-.5-1.8-1.3-2.4A6 6 0 0 1 12 3.6Z"
    /><path d="M9.8 19.4h4.4" /><circle
      cx="12"
      cy="10.4"
      r="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
