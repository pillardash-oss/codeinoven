<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import Mark from '#lib/components/Mark.svelte'
  import TitleMenu from '#lib/components/TitleMenu.svelte'
  import { toneColor } from '#lib/api/status'
  import { arrive } from '#lib/motion'
  import type { Project } from '#lib/api/types'
  import type { PageData } from './$types'

  /**
   * The work list read as projects: what each one is called, how many threads it
   * holds, and what those threads are doing. Choosing a project opens its threads
   * in the other reading of this same list, which is the phone's whole scope
   * mechanism, so nothing here duplicates the thread list.
   */
  interface ClusterEntry {
    count: number
    label: string
    tone: string
    toneName: string
  }

  let { data }: { data: PageData } = $props()

  /** Only what is actually happening: a project with nothing open shows no dots. */
  function cluster(project: Project): ClusterEntry[] {
    const counts = project.statusCounts
    const entries: ClusterEntry[] = [
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

  function threadsLabel(count: number): string {
    return count === 1 ? '1 thread' : `${count} threads`
  }
</script>

<PanelBar
  title="Projects"
  subtitle={data.projects.length === 1 ? '1 project' : `${data.projects.length} projects`}
>
  {#snippet titleControl()}
    <TitleMenu
      view="projects"
      title="Projects"
      count={data.projects.length}
      threads={data.threadCount}
      projects={data.projects.length}
    />
  {/snippet}
</PanelBar>

<div class="list">
  {#if data.error}
    <p class="empty">{data.error}</p>
  {:else}
    <a class="project-strip" href="/threads" in:arrive>
      <span class="strip-glyph"><CioThreads size={17} /></span>
      <span class="strip-cell">
        <span class="strip-name">All threads</span>
        <span class="strip-meta">{threadsLabel(data.threadCount)}</span>
      </span>
      <span class="strip-more"><CioChevronDown size={15} class="strip-caret" /></span>
    </a>

    {#each data.projects as project (project.id)}
      <a class="project-strip" href="/threads?project={project.id}" in:arrive>
        <Mark {project} size={28} />
        <span class="strip-cell">
          <span class="strip-name">{project.name}</span>
          <span class="strip-meta">{threadsLabel(project.threadCount)}</span>
        </span>
        <span class="strip-state">
          {#each cluster(project) as entry (entry.toneName)}
            <span class="strip-pip" style:color={entry.tone}>
              <i class="dot" style:background={entry.tone} aria-hidden="true"></i>{entry.count}
              <span class="sr-only">{entry.label}</span>
            </span>
          {/each}
        </span>
        <span class="strip-more"><CioChevronDown size={15} class="strip-caret" /></span>
      </a>
    {/each}
  {/if}
</div>
