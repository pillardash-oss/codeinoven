<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Thread note
  Thread note: a quill. The vane runs both sides of the shaft and tapers to a
  point at each end, the shaft carries on past the vane to the nib, and one
  solid band crosses the middle. The mark it replaces hung a card off a bar on
  the left, which made it narrower than every mark beside it, and the pass
  after that was a single-sided blade, which read as the bowl of a spoon.
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
    transform="translate(0.508 -0.499) scale(0.9996)"
    stroke-width={cioStrokeWidth(weight, 0.9996)}
  >
    <path d="M21.6 2.4Q7.06 5.06 4.4 19.6Q18.94 16.94 21.6 2.4Z" /><path d="M21.6 2.4 1.4 22.6" /><g
      transform="rotate(-45 12 12)"
      ><rect
        x="8.6"
        y="11.1"
        width="6.8"
        height="1.7"
        rx="0.85"
        fill="currentColor"
        stroke="none"
      /></g
    >
  </g>
</svg>
