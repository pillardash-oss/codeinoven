<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Appearance
  Appearance: a palette with three solid wells, which is what makes it a
  colour set rather than a mask.
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
    transform="translate(-2.482 -2.482) scale(1.2068)"
    stroke-width={cioStrokeWidth(weight, 1.2068)}
  >
    <path
      d="M12 3.8a8.2 8.2 0 0 0 0 16.4c1.3 0 2.1-.9 2.1-2 0-.6-.3-1-.6-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h1.6a3.6 3.6 0 0 0 3.6-3.6C20.2 6.8 16.6 3.8 12 3.8Z"
    /><circle
      cx="8.4"
      cy="9.2"
      r="1.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle
      cx="12"
      cy="7.4"
      r="1.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle
      cx="15.6"
      cy="9.6"
      r="1.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
