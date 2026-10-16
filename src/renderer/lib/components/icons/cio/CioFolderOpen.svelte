<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Open folder
  Open folder: the folder with its front swung forward on a solid lip, so it
  is the same object in a second state.
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
    transform="translate(-2.415 -1.820) scale(1.1816)"
    stroke-width={cioStrokeWidth(weight, 1.1816)}
  >
    <path d="M6.6 5.8h2l2.2 2.8h8.4a1.6 1.6 0 0 1 1.6 1.6v1.4" /><path
      d="M3.6 17.6 5.8 10h14.8l-2.4 7.6Z"
    /><rect x="7.4" y="10.6" width="9.6" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
