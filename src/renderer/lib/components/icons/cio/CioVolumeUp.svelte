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
  CIO · Volume up
  The volume set's speaker with one more rule than silence carries: the same
  body as the muted glyph, and the waves a louder step adds. A step is drawn by
  how many waves it has, never by a different speaker, so a quiet device and a
  loud one read as one control.
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
    transform="translate(-3.532 -2.740) scale(1.2284)"
    stroke-width={cioStrokeWidth(weight, 1.2284)}
  >
    <path d="M4.6 9.4h3.6L12.8 5.4v13.2l-4.6-4H4.6Z" />
    <path d="M16.2 9.6a3.6 3.6 0 0 1 0 4.8" />
    <path d="M18.8 7.2a7 7 0 0 1 0 9.6" />
    <path d="M21 4.8a10.4 10.4 0 0 1 0 14.4" />
  </g>
</svg>
