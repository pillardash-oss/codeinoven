<script lang="ts">
  import { cioStrokeWidth } from '@pdslng/cio-icon/glyph'

  let {
    size = 16,
    strokeWidth = 1.8,
    class: className = '',
    ...rest
  }: {
    size?: number | string
    strokeWidth?: number | string
    class?: string
    [key: string]: unknown
  } = $props()

  const weight = $derived(
    typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8
  )
</script>

<!--
  CIO · Pi
  Pi: the glyph itself, a crossbar over two legs. The right leg is drawn longer
  than the left on purpose, which is how the letter is actually shaped; two legs
  of equal length read as a table rather than as pi.
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
  aria-hidden="true"
  {...rest}
>
  <g
    transform="translate(-1.870 -1.870) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <path d="M5.6 7.9h12.8" />
    <path d="M9.1 7.9v7.6c0 1.2.9 2.1 2.1 2.1" />
    <path d="M14.9 7.9v8.6" />
  </g>
</svg>
