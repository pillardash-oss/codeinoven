<script lang="ts">
  import { formatAge, statusSkin } from '#lib/api/status'
  import { arrive } from '#lib/motion'
  import type { Project, Thread } from '#lib/api/types'
  import Mark from './Mark.svelte'

  /**
   * One thread, as a row. The project variant carries the project's mark,
   * because in the all-threads list nothing above the row says which project
   * it belongs to.
   */
  interface Props {
    thread: Thread
    project?: Project | null
    /** Show the project mark and name, for a list that spans projects. */
    showProject?: boolean
    /** The row at 1rem tall for a thread list inside a project strip. */
    compact?: boolean
  }

  let { thread, project = null, showProject = false, compact = false }: Props = $props()

  let skin = $derived(statusSkin(thread.status))
  let live = $derived(thread.status === 'executing' || thread.status === 'planning')
  let unread = $derived(!thread.read)
</script>

<a class={['row', { flat: showProject, compact }]} href="/threads/{thread.id}" in:arrive>
  {#if showProject && project}
    <Mark {project} size={28} />
  {:else}
    <!-- Inside a project strip the state mark leads the row, because the project
         is already named above it; in the all-threads list it trails, because
         the project mark has to lead instead. -->
    <span
      class="tmark"
      data-rail={live ? '' : 'none'}
      style:color={live ? 'var(--color-info)' : undefined}
    >
      <skin.icon size={14} />
      <i></i>
    </span>
  {/if}
  <span class="body-cell">
    <span class={['row-title', { unread }]}>{thread.title}</span>
    {#if showProject && project}
      <span class="row-line">
        <span class="row-project" title={project.name}>{project.name}</span>
        <span class="row-dot" aria-hidden="true">·</span>
        <span class="row-state">{skin.label}</span>
        <span class="row-dot" aria-hidden="true">·</span>
        <span class="row-age">{formatAge(thread.lastActivity)}</span>
      </span>
    {:else}
      <span class="row-meta">
        <span class="state" style:color={live ? 'var(--color-info)' : undefined}>{skin.label}</span>
        <span class="age">{formatAge(thread.lastActivity)}</span>
      </span>
    {/if}
  </span>
  {#if showProject}
    <span
      class="tmark"
      data-rail={live ? '' : 'none'}
      style:color={live ? 'var(--color-info)' : undefined}
      style:align-self="center"
      style:height="1rem"
    >
      <skin.icon size={14} />
      <i></i>
    </span>
  {/if}
  {#if unread}
    <span class="sr-only">Unread</span>
  {/if}
</a>

<style>
  /* Only the project name gives way when the line runs out of room. The state
     and the age are the two facts the line exists for, so they never truncate
     and a long project cannot hide what needs the user. */
  .row-line {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    white-space: nowrap;
  }

  .row-project {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-dot,
  .row-state,
  .row-age {
    flex: none;
  }
</style>
