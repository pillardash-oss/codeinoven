<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Cloud deployments
  Cloud deployments: a cloud carrying a solid bar, which is the deployment
  payload. A bare cloud read as weather, and an arrow inside it disappeared
  at 16px.
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
    transform="translate(-0.249 0.359) scale(1.0584)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.0584)}
  >
    <path d="M6.4 17.6h11.2a4 4 0 0 0 .6-7.9 6.2 6.2 0 0 0-12-1.1 3.6 3.6 0 0 0 .2 9Z" />
    <rect x="9.2" y="11.4" width="5.6" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
  </g>
</svg>
