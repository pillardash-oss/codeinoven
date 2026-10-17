<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Shred
  Shred: a sheet feeding into a solid machine head with the strips it has made
  falling out below it, which is a document destroyed from that line onward
  rather than a bin holding one.
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
    transform="translate(-2.482 -2.242) scale(1.2069)"
    stroke-width={cioStrokeWidth(weight, 1.2069)}
  >
    <rect x="7.4" y="3.6" width="9.2" height="7.4" rx="1.2" /><rect
      x="4.4"
      y="11"
      width="15.2"
      height="3.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><path d="M7.8 14.2v4.4" /><path d="M12 14.2v5.8" /><path d="M16.2 14.2v4.4" />
  </g>
</svg>
