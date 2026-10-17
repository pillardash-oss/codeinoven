<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Debug off
  Debug off: the debugger mark struck through, which is the debugger turned
  off rather than a debugger that is not there. Reusing the plain mark said
  the opposite of what the control does.
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
    transform="translate(-2.169 -2.169) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <rect x="6" y="7.4" width="12" height="12" rx="6" /><path d="M6 10.6H3.6" /><path
      d="M6 16.4H3.6"
    /><path d="M18 10.6h2.4" /><path d="M18 16.4h2.4" /><rect
      x="8.6"
      y="12.2"
      width="6.8"
      height="2.6"
      rx="1.3"
      fill="currentColor"
      stroke="none"
    /><path d="M4.4 19.6 19.6 4.4" />
  </g>
</svg>
