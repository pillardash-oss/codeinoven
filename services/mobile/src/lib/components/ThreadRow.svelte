<script lang="ts">
  import { formatAge, statusSkin, toneColor } from '#lib/api/status'
  import type { Project, Thread } from '#lib/api/types'
  import { arrive } from '#lib/motion'
  import Mark from './Mark.svelte'

  /**
   * One thread, as a row: a dot for what it is doing, its name, one line about it,
   * and its age. The dot carries the state so no icon competes with the name, and
   * the age keeps the same column down the list.
   */
  interface Props {
    thread: Thread
    /** The project the row belongs to, named only in a list that spans projects. */
    project?: Project | null
  }

  let { thread, project = null }: Props = $props()

  let skin = $derived(statusSkin(thread.status))
  let live = $derived(thread.status === 'executing' || thread.status === 'planning')
  let unread = $derived(!thread.read)
  let tone = $derived(toneColor(skin.tone))
  let about = $derived(project ? `${skin.label} · ${project.name}` : skin.label)
</script>

<a class="thread-row" href="/threads/{thread.id}" in:arrive>
  <span class="thread-mark">
    {#if project}
      <Mark {project} size={24} />
    {:else}
      <span class="thread-dot" data-live={live} style:background={tone} aria-hidden="true"></span>
    {/if}
  </span>
  <span class="thread-cell">
    <span class="thread-name" class:unread>{thread.title}</span>
    <span class="thread-meta">{about}</span>
  </span>
  <time class="thread-age" datetime={new Date(thread.lastActivity).toISOString()}>
    {formatAge(thread.lastActivity)}
  </time>
  {#if unread}<span class="sr-only">Unread</span>{/if}
</a>
