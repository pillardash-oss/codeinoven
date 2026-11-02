<script lang="ts">
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import type { Project } from '#lib/api/types'

  /**
   * A project's mark. The desktop lets a user paste an SVG or pick an accent
   * colour, and both survive the trip through the service, so the phone draws
   * the same identity rather than a generic folder for every project.
   */
  interface Props {
    project: Pick<Project, 'name' | 'customSvg' | 'color'>
    size?: number
    /** 'plain' drops the tinted plate, for a mark that carries its own field. */
    plain?: boolean
  }

  let { project, size = 28, plain = false }: Props = $props()

  let initials = $derived(
    project.name
      .split(/[\s-_]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  )

  let customIcon = $derived(
    project.customSvg
      ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(project.customSvg)))}`
      : null
  )

  let tint = $derived(
    project.color
      ? {
          background: `color-mix(in srgb, ${project.color} 16%, transparent)`,
          color: project.color
        }
      : null
  )
</script>

<span
  class={['mark', { plain }]}
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.36)}px"
  style:background={plain ? undefined : tint?.background}
  style:color={tint?.color}
  aria-hidden="true"
>
  {#if customIcon}
    <img src={customIcon} alt="" width={size} height={size} />
  {:else if project.color}
    {initials}
  {:else}
    <CioFolder size={Math.round(size * 0.62)} />
  {/if}
</span>
