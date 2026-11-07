<script lang="ts">
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import { customSvgDataUrl, markInitials } from '#lib/marks'
  import type { Project } from '#lib/api/types'

  /**
   * A project's mark, the way the desktop draws it: the stored SVG tinted with
   * the project's own colour, its initials on a wash of that colour, or the
   * folder glyph when the project declares neither.
   */
  interface Props {
    project: Pick<Project, 'name' | 'customSvg' | 'color'>
    size?: number
  }

  let { project, size = 28 }: Props = $props()

  let initials = $derived(markInitials(project.name))
  let svg = $derived(
    project.customSvg && project.color ? customSvgDataUrl(project.customSvg, project.color) : null
  )
</script>

<span
  class={['mark', { plain: svg !== null }]}
  style:width="{size}px"
  style:height="{size}px"
  style:--tint={project.color ?? undefined}
  style:font-size="{Math.round(size * 0.34)}px"
  aria-hidden="true"
>
  {#if svg}
    <img src={svg} alt="" width={size} height={size} />
  {:else if project.color}
    {initials}
  {:else}
    <CioFolder size={Math.round(size * 0.62)} />
  {/if}
</span>
