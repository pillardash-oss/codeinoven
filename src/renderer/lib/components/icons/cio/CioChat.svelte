<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Chat
  Chats: a squared bubble with a tapered tail and the line that was said.
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
    transform="translate(-2.023 -3.543) scale(1.1686)"
    stroke-width={cioStrokeWidth(weight, 1.1686)}
  >
    <path
      d="M3.5 8.6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v5.8a2 2 0 0 1-2 2h-7.3L7.4 20v-3.6H5.5a2 2 0 0 1-2-2Z"
    /> <rect x="7.2" y="10.3" width="9.6" height="2.4" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
