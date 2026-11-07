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
  CIO · Phone
  Phone: a tall frame with one speaker rule and its home band, which is what
  makes it a handset rather than the tablet's squarer sheet.
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
    <rect x="6.9" y="4.2" width="10.2" height="15.6" rx="0" />
    <path d="M10.6 6.8h2.8" />
    <path d="M10.9 17.2h2.2" />
  </g>
</svg>
