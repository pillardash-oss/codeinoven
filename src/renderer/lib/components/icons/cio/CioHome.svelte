<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Home
  Home: a roof over a door, the door solid, which is where a workspace starts
  rather than a folder.
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
    transform="translate(-2.482 -2.242) scale(1.2068)"
    stroke-width={cioStrokeWidth(weight, 1.2068)}
  >
    <path d="M3.8 11.4 12 3.8l8.2 7.6" /><path d="M5.8 10.6v9.2h12.4v-9.2" /><rect
      x="10.4"
      y="13.6"
      width="3.2"
      height="6.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
