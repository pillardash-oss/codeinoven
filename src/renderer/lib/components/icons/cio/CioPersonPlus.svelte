<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Invite
  Invite: the person mark with a solid plus beside it, for an account being
  brought in.
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
    transform="translate(-1.996 -2.203) scale(1.1038)"
    stroke-width={cioStrokeWidth(weight, 1.1038)}
  >
    <circle cx="10.4" cy="8.2" r="3.8" fill="currentColor" stroke="none" /><path
      d="M3.4 20.4a7 7 0 0 1 13.4-2.6"
    /><rect x="18.4" y="12.2" width="2" height="7" rx="1" fill="currentColor" stroke="none" /><rect
      x="15.9"
      y="14.7"
      width="7"
      height="2"
      rx="1"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
