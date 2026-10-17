<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Commit graph
  Commit graph: a trunk with two nodes and a branch curving off to a third,
  which is history as a shape. The clock the retry mark owns says when, not
  what happened.
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
    transform="translate(-3.618 -3.882) scale(1.3235)"
    stroke-width={cioStrokeWidth(weight, 1.3235)}
  >
    <path d="M7.6 4.6v14.8" /><circle
      cx="7.6"
      cy="7.6"
      r="1.9"
      fill="currentColor"
      stroke="none"
    /><circle cx="7.6" cy="16.4" r="1.9" fill="currentColor" stroke="none" /><path
      d="M7.6 12h4.6a3.8 3.8 0 0 0 3.8-3.8V7.6"
    /><circle cx="16" cy="7.6" r="1.9" fill="currentColor" stroke="none" />
  </g>
</svg>
