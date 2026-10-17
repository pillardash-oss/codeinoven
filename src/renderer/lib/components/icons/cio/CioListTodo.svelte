<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · To do
  To do: a spine whose top rung is an open box and whose other rungs are
  rules, which is a list with something still owed on it. The thread mark
  carries no box, so it reads as a record rather than as work.
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
    transform="translate(-5.433 -3.994) scale(1.4276)"
    stroke-width={cioStrokeWidth(weight, 1.4276)}
  >
    <path d="M5.4 7.4v10.2" /><rect x="8.6" y="4.8" width="4.4" height="4.4" rx="1.3" /><path
      d="M8.6 12.4h10.4"
    /><path d="M8.6 16.8h7" />
  </g>
</svg>
