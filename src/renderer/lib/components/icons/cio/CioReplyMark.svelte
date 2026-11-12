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
  /** An icon is decoration unless the call site names it for a screen reader. */
  const named = $derived(rest['aria-label'] !== undefined || rest['role'] === 'img')
</script>

<!--
  CIO · Reply
  Reply: one shaft that folds back to the left and the arm that carries the
  answer away, so it reads as answering a message rather than as Undo's
  round-trip arrow.
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
  <g stroke-width={cioStrokeWidth(weight, 1)}>
    <path d="M9.5 5.5 4 11l5.5 5.5" />
    <path d="M4 11h9.5a5.5 5.5 0 0 1 5.5 5.5V20" />
  </g>
</svg>
