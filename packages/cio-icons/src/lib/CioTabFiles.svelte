<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Files tab
  Files: two sheets with one solid line on the front sheet. The dock Workspace
  files is a folder tree; this one is the pages themselves, so the two never
  collide.
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
    transform="translate(-2.242 -2.723) scale(1.2069)"
    stroke-width={cioStrokeWidth(weight, 1.2069)}
  >
    <rect x="4.2" y="6.4" width="11" height="14" rx="0" /><path
      d="M8.2 6.4V6a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2v10.6a2 2 0 0 1-2 2h-.4"
    /><rect
      x="7"
      y="11.6"
      width="5.6"
      height="2.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
