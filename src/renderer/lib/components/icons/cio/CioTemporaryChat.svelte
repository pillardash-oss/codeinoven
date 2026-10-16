<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Temporary chat
  Temporary chat: the chat bubble with a bite out of its lower right, so it is
  the same object as Chats with one thing missing rather than a different
  object. A dashed outline was tried and the dashes fell under the 1.5-unit
  floor.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  <g
    transform="translate(-2.833 -4.090) scale(1.2470)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.247)}
  >
    <path d="M8.6 6.6H6.2a2.4 2.4 0 0 0-2.4 2.4v4.8a2.4 2.4 0 0 0 2.4 2.4h1.4l3.4 3v-3" /><path
      d="M14.8 6.6h2.8a2.4 2.4 0 0 1 2.4 2.4v2.2"
    /><rect x="6.6" y="10.6" width="8.4" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
  </g>
</svg>
