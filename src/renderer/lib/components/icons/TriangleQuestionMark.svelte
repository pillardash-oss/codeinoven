<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements'

  /**
   * Lucide ships no triangle-question-mark, so this follows lucide icon
   * conventions (24 grid, 2px round currentColor strokes) by combining the
   * triangle-alert outline with the circle-question-mark curve.
   */
  interface Props extends SVGAttributes<SVGSVGElement> {
    size?: number | string
  }

  let { size = 24, class: className = '', ...rest }: Props = $props()
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  {...rest}
>
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
  <g transform="translate(2.4 3) scale(0.8)">
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </g>
</svg>
