<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Pull request
  Pull request: a branch feeding an arrow into a line with a second node,
  which is a change waiting to be merged.
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
    transform="translate(-2.375 -2.625) scale(1.2555)"
    stroke-width={cioStrokeWidth(weight, 1.2555)}
  >
    <circle cx="6.6" cy="6.4" r="2.6" /><rect
      x="5.6"
      y="9"
      width="2"
      height="8.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><path d="M17.4 15.4V12a3.4 3.4 0 0 0-3.4-3.4H10.6" /><path
      d="M13.4 6.2 10.4 8.6l3 2.4"
    /><circle cx="17.4" cy="18" r="2.4" fill="currentColor" stroke="none" />
  </g>
</svg>
