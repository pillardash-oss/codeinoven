<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import Mark from '#lib/components/Mark.svelte'
  import ThreadRow from '#lib/components/ThreadRow.svelte'
  import TitleMenu from '#lib/components/TitleMenu.svelte'
  import { toneColor } from '#lib/api/status'
  import { arrive } from '#lib/motion'
  import type { Project, Thread } from '#lib/api/types'
  import type { PageData } from './$types'

  /**
   * The work list read as projects, the way the desktop panel draws it: one
   * foldable strip per project, and that project's threads inside the strip when
   * it is open. The strip itself is the whole control, so reading a project
   * never leaves this list.
   */
  interface StatusEntry {
    count: number
    label: string
    tone: string
    toneName: string
  }

  let { data }: { data: PageData } = $props()

  /** Which strips are open. Every project starts folded, as the desktop draws it. */
  let open = $state(new SvelteSet<string>())

  let grouped = $derived.by(() => {
    const groups = new Map<string, Thread[]>()
    for (const thread of data.threads) {
      const held = groups.get(thread.projectId)
      if (held) held.push(thread)
      else groups.set(thread.projectId, [thread])
    }
    return groups
  })

  function threadsOf(projectId: string): Thread[] {
    return grouped.get(projectId) ?? []
  }

  function toggle(projectId: string): void {
    if (open.has(projectId)) open.delete(projectId)
    else open.add(projectId)
  }

  function panelId(projectId: string): string {
    return `project-threads-${projectId}`
  }

  /** Only what is actually happening: a project with nothing open shows no dots. */
  function statuses(project: Project): StatusEntry[] {
    const counts = project.statusCounts
    const entries: StatusEntry[] = [
      {
        count: counts.attention,
        label: 'need attention',
        tone: toneColor('attention'),
        toneName: 'attention'
      },
      { count: counts.spec, label: 'have a spec ready', tone: toneColor('spec'), toneName: 'spec' },
      { count: counts.working, label: 'working', tone: toneColor('working'), toneName: 'working' }
    ]
    return entries.filter((entry) => entry.count > 0)
  }
</script>

<PanelBar title="Projects">
  {#snippet titleControl()}
    <TitleMenu view="projects" title="Projects" />
  {/snippet}
</PanelBar>

<div class="list">
  {#if data.error}
    <p class="empty">{data.error}</p>
  {:else if data.projects.length === 0}
    <p class="empty">No projects yet.</p>
  {:else}
    {#each data.projects as project (project.id)}
      <button
        class="project-strip"
        type="button"
        aria-expanded={open.has(project.id)}
        aria-controls={panelId(project.id)}
        onclick={() => toggle(project.id)}
        in:arrive
      >
        <Mark {project} size={28} />
        <span class="strip-cell">
          <span class="strip-name">{project.name}</span>
        </span>
        <span class="strip-state">
          {#each statuses(project) as entry (entry.toneName)}
            <span class="strip-pip" style:color={entry.tone}>
              <i class="dot" style:background={entry.tone} aria-hidden="true"></i>{entry.count}
              <span class="sr-only">{entry.label}</span>
            </span>
          {/each}
        </span>
        <span class="strip-more"><CioChevronDown size={15} class="strip-caret" /></span>
      </button>

      {#if open.has(project.id)}
        <div class="project-threads" id={panelId(project.id)}>
          {#if threadsOf(project.id).length === 0}
            <p class="project-empty">No threads yet</p>
          {:else}
            {#each threadsOf(project.id) as thread (thread.id)}
              <ThreadRow {thread} />
            {/each}
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</div>
