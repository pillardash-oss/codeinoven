<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    /** Icon edge length in px, the same `size` prop every CIO glyph takes. */
    size?: number | string
    /** Fill color for the monochrome brand mark. Defaults to currentColor. */
    color?: string
    class?: string
    /** The SVG `viewBox` this brand mark uses (brand marks are not 24×24 boxes). */
    viewBox?: string
    /** Accessibility title shown as `<title>`; when absent the icon is aria-hidden. */
    title?: string
    children: Snippet
  }

  let {
    size = 24,
    color = 'currentColor',
    class: className = '',
    viewBox = '0 0 24 24',
    title,
    children
  }: Props = $props()
</script>

<!--
  A wrapper for solid brand marks. Brand logos are filled paths, not stroked
  outlines, so this renders `fill={color}` rather than the stroke model the CIO
  set draws with, while keeping the same `size` / `class` / `color` props so a
  call site reads the same either way.
-->
<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  {viewBox}
  fill={color}
  role={title ? 'img' : undefined}
  aria-hidden={title ? undefined : 'true'}
  class={['lucide-icon lucide', className]}
>
  {#if title}
    <title>{title}</title>
  {/if}
  {@render children()}
</svg>
