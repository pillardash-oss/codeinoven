<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import NewProjectSheet from '#lib/components/NewProjectSheet.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import Mark from '#lib/components/Mark.svelte'
  import ThreadRow from '#lib/components/ThreadRow.svelte'
  import TitleMenu from '#lib/components/TitleMenu.svelte'
  import { fold } from '#lib/motion'
  import { toneColor } from '#lib/api/status'
  import type { Project, Thread } from '#lib/api/types'
  import type { PageData } from './$types'

  /**
   * The work list read as projects, drawn the way the design draws the desktop
   * sidebar on a phone: one foldable strip per project, its identity and the
   * states that exist right now, and the project's threads inside it when it is
   * open. The strip is the whole control, so reading a project never leaves this
   * list.
   */
  interface StatusEntry {
    count: number
    label: string
    tone: 'working' | 'needs' | 'spec'
    color: string
  }

  let { data }: { data: PageData } = $props()

  /** Which strips are open. Every project starts folded, as the desktop draws it. */
  let open = $state(new SvelteSet<string>())

  /** The project sheet is one control on this screen: name it, then it exists. */
  let projectSheetOpen = $state(false)

  function startProject(): void {
    projectSheetOpen = true
  }

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
        tone: 'needs',
        color: toneColor('attention')
      },
      { count: counts.spec, label: 'have a spec ready', tone: 'spec', color: toneColor('spec') },
      { count: counts.working, label: 'working', tone: 'working', color: toneColor('working') }
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
    <div class="list-foot">
      <button class="btn quiet with-icon" type="button" onclick={startProject}>
        <CioPlus size={14} />
        Start a project
      </button>
    </div>
  {:else}
    {#each data.projects as project (project.id)}
      <section class="strip" data-open={open.has(project.id)}>
        <div class="strip-head">
          <button
            class="strip-toggle"
            type="button"
            aria-expanded={open.has(project.id)}
            aria-controls={panelId(project.id)}
            onclick={() => toggle(project.id)}
          >
            <span class="strip-id">
              <CioChevronDown class="strip-caret" size={14} />
              <Mark {project} size={28} />
              <span class="strip-name">{project.name}</span>
            </span>
            {#if statuses(project).length > 0}
              <span class="strip-state">
                {#each statuses(project) as entry (entry.tone)}
                  <span style:color={entry.color}>
                    <i class="dot" data-tone={entry.tone}></i>{entry.count}
                    <span class="sr-only">{entry.label}</span>
                  </span>
                {/each}
              </span>
            {/if}
          </button>
        </div>

        {#if open.has(project.id)}
          <div class="strip-body" id={panelId(project.id)} transition:fold>
            {#if threadsOf(project.id).length === 0}
              <p class="project-empty">No threads yet</p>
            {:else}
              {#each threadsOf(project.id) as thread (thread.id)}
                <ThreadRow {thread} variant="strip" />
              {/each}
            {/if}
          </div>
        {/if}
      </section>
    {/each}

    <div class="list-foot">
      <button class="btn quiet with-icon" type="button" onclick={startProject}>
        <CioPlus size={14} />
        New project
      </button>
    </div>
  {/if}
</div>

<NewProjectSheet open={projectSheetOpen} onclose={() => (projectSheetOpen = false)} />
