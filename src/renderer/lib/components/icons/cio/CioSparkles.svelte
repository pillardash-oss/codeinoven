<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Generated
  Generated: one solid sparkle with a smaller outlined one beside it. The
  solid one carries the meaning and the outline says there is more of it.
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
    transform="translate(-4.317 -3.508) scale(1.2555)"
    stroke-width={cioStrokeWidth(weight, 1.2555)}
  >
    <path
      d="M10.6 3.6l1.7 4.6 4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6L4.3 9.9l4.6-1.7Z"
      fill="currentColor"
      stroke="none"
    /><path d="M17.6 13.8l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9Z" />
  </g>
</svg>
