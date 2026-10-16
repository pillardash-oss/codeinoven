<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Changes
  Changes: the page carries both signs now, a solid plus above a solid minus
  on the same axis, which is what a change set is. It carried only the plus
  before, which made it the comment mark with different content, and carried
  no minus at all.
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
    transform="translate(-0.729 -4.899) scale(1.2616)"
    stroke-width={cioStrokeWidth(weight, 1.2616)}
  >
    <path
      d="M4.6 5.4h8.6l4.6 4.6v9.2a2.2 2.2 0 0 1-2.2 2.2H4.6a2.2 2.2 0 0 1-2.2-2.2V7.6a2.2 2.2 0 0 1 2.2-2.2Z"
    /><rect
      x="8.5"
      y="9.8"
      width="2.2"
      height="4.6"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><rect
      x="7.3"
      y="11"
      width="4.6"
      height="2.2"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><rect x="7.3" y="15.4" width="4.6" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
