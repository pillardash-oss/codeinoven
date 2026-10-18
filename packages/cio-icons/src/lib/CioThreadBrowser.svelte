<script lang="ts">
  import type { CioGlyphProps } from './glyph'

  let { size = 16, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)
</script>

<!--
  CIO · Browser in a thread
  Browser in a thread: the browser mark itself, with a thread run as a bar
  from the centre to the right. The bar is one more subpath of the same
  even-odd path as the disc and the ring, so where it crosses the ring both
  are knocked out and the ring reads open on the right. The mark before it was
  a disc of its own with a crescent bitten out of it, which filled the circle
  and read as a smudge.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="currentColor"
  stroke="none"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <path
    fill-rule="evenodd"
    d="M0.700,12A11.300,11.300 0 1 1 23.300,12A11.300,11.300 0 1 1 0.700,12ZM3.504,8.217A9.300,7.000 24 0 0 20.496,15.783A9.300,7.000 24 0 0 3.504,8.217ZM11.0,10.95H21.6A0.95,0.95 0 0 1 21.6,12.85H11.0A0.95,0.95 0 0 1 11.0,10.95Z"
    style="fill: var(--icon-anchor, currentColor)"
  />
</svg>
