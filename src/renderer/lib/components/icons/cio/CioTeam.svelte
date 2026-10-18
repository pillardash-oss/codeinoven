<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Team
  Team: two people, the one in front solid, which is a group of agents rather
  than a single account.
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
    transform="translate(-1.928 -2.633) scale(1.1791)"
    stroke-width={cioStrokeWidth(weight, 1.1791)}
  >
    <circle cx="16.6" cy="8" r="2.8" /><path d="M14.4 19.6a5.6 5.6 0 0 1 5.8-5.4" /><circle
      cx="9"
      cy="7.8"
      r="3.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M3.4 19.6a5.6 5.6 0 0 1 11.2 0" />
  </g>
</svg>
