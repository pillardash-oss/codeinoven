<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Browser in a thread
  Browser in a thread: the thread mark with the browser mark hanging off it,
  the same construction the thread note uses, so a reader who knows one knows
  the other.
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
    transform="translate(-3.812 -2.482) scale(1.2068)"
    stroke-width={cioStrokeWidth(weight, 1.2068)}
  >
    <path d="M6.2 3.8v16.4" /><rect x="8.8" y="7.4" width="11.2" height="9.2" rx="2.2" /><ellipse
      cx="14.4"
      cy="12"
      rx="4.6"
      ry="2"
      transform="rotate(-24 14.4 12)"
    /><circle cx="14.4" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </g>
</svg>
