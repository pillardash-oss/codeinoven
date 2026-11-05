<script lang="ts">
  import { formatAge, statusSkin } from '#lib/api/status'
  import type { Project, Thread } from '#lib/api/types'
  import Mark from './Mark.svelte'
  import StatusMark from './StatusMark.svelte'

  /**
   * One thread, drawn the way the design draws it.
   *
   * In the threads reading the row leads with the project's mark, because no
   * heading says which project the thread belongs to, and closes with its state
   * mark on the far edge.
   *
   * Inside a project strip the strip already said the project, so the row leads
   * with its state mark and its dashed spine instead, and the state and age sit
   * on the line under the name.
   */
  interface Props {
    thread: Thread
    /** The project the row belongs to, named only in the flat reading. */
    project?: Project | null
    variant?: 'flat' | 'strip'
  }

  let { thread, project = null, variant = 'flat' }: Props = $props()

  let skin = $derived(statusSkin(thread.status))
  let age = $derived(formatAge(thread.lastActivity))
</script>

{#if variant === 'strip'}
  <a class="row" href="/threads/{thread.id}">
    <StatusMark status={thread.status} />
    <span class="body-cell">
      <span class="row-title" class:unread={!thread.read}>{thread.title}</span>
      <span class="row-meta">
        <span class="state">{skin.label}</span>
        <span class="age">{age}</span>
      </span>
    </span>
    {#if !thread.read}<span class="sr-only">Unread</span>{/if}
  </a>
{:else}
  <a class="row flat" href="/threads/{thread.id}">
    {#if project}
      <Mark {project} size={28} />
    {:else}
      <span class="mark" aria-hidden="true"></span>
    {/if}
    <span class="body-cell">
      <span class="row-title" class:unread={!thread.read}>{thread.title}</span>
      <span class="row-line">
        {#if project}<span class="row-project">{project.name}</span
          >{' · '}{/if}{skin.label}{' · '}{age}
      </span>
    </span>
    <StatusMark status={thread.status} rail={false} />
    {#if !thread.read}<span class="sr-only">Unread</span>{/if}
  </a>
{/if}
