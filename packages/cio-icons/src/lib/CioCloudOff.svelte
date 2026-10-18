<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · No remote
  No remote: the cloud struck through, which is a remote that could not be
  reached rather than one that is absent.
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
  <g
    transform="translate(-1.177 -1.241) scale(1.1034)"
    stroke-width={cioStrokeWidth(weight, 1.1034)}
  >
    <path d="M7.4 18.4a4.2 4.2 0 0 1-.6-8.4 5.6 5.6 0 0 1 10.8 1.2 3.6 3.6 0 0 1-.4 7.2Z" /><path
      d="M4.4 19.6 19.6 4.4"
    />
  </g>
</svg>
