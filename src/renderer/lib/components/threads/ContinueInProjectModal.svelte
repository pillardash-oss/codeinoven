<script lang="ts">
  import { Folder, Search } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import ProjectCreateControl from '../shared/ProjectCreateControl.svelte'
  import ProjectIdentity from '../shared/ProjectIdentity.svelte'
  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import type { Project } from '$shared/types'

  interface Props {
    open: boolean
    /** Projects the chat can be continued into. */
    projects: Project[]
    projectIcons: ReadonlyMap<string, string>
    onClose: () => void
    /** Called with the chosen project when the user continues the chat there. */
    onContinue: (project: Project) => void | Promise<void>
    /** Called after a brand-new project is created from the add-project control. */
    onProjectCreated: (project: Project) => void | Promise<void>
    /** True while the continue action is in flight. */
    busy?: boolean
  }

  let {
    open,
    projects,
    projectIcons,
    onClose,
    onContinue,
    onProjectCreated,
    busy = false
  }: Props = $props()

  let query = $state('')
  let selectedId = $state<string | null>(null)

  const filtered = $derived(
    projects.filter((project) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return (
        project.name.toLowerCase().includes(q) ||
        project.path.toLowerCase().includes(q) ||
        (project.host ?? '').toLowerCase().includes(q)
      )
    })
  )

  function confirm(): void {
    if (busy) return
    const project = projects.find((candidate) => candidate.id === selectedId)
    if (!project) return
    void onContinue(project)
  }

  function handleCreated(project: Project): void {
    selectedId = project.id
    void onProjectCreated(project)
    void onContinue(project)
  }
</script>

<Modal {open} title="Continue chat in a project" {onClose}>
  <div class="flex flex-col gap-4">
    <p class="text-sm leading-relaxed text-muted">
      Continue this chat as a thread inside a project. The conversation carries over and you keep
      prompting from there.
    </p>

    <div class="relative">
      <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-dimmed" />
      <input
        type="text"
        class="w-full rounded-lg border bg-elevated py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-dimmed"
        placeholder="Search projects…"
        aria-label="Search projects"
        bind:value={query}
      />
    </div>

    <div class="max-h-72 overflow-y-auto rounded-xl border border-border">
      {#if filtered.length > 0}
        <ul class="divide-y divide-border">
          {#each filtered as project (project.id)}
            {@const icon = getProjectIcon(project, projectIcons.get(project.id) ?? undefined)}
            <li>
              <button
                class="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-elevated {selectedId ===
                project.id
                  ? 'bg-overlay'
                  : ''}"
                title="Continue in {project.name}"
                aria-pressed={selectedId === project.id}
                disabled={busy}
                onclick={() => (selectedId = project.id)}
              >
                {#if icon}
                  <img
                    src={icon}
                    alt=""
                    class="h-5 w-5 shrink-0 object-contain"
                    draggable="false"
                    onerror={projectIconOnError(project)}
                  />
                {:else}
                  <Folder size={16} class="shrink-0 text-muted" />
                {/if}
                <ProjectIdentity {project} class="min-w-0 flex-1" showLocation />
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Folder size={20} class="text-dimmed" />
          <p class="text-sm text-muted">No {query.trim() ? 'matching' : ''} projects</p>
          <p class="text-xs text-dimmed">Add a local folder or an SSH project below to continue.</p>
        </div>
      {/if}
    </div>

    <div class="flex items-center justify-between border-t border-border pt-3">
      <span class="text-xs text-dimmed">New project</span>
      <ProjectCreateControl
        {projects}
        onProjectCreated={handleCreated}
        title="Add a project to continue in"
      />
    </div>
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      title="Continue this chat in the selected project"
      disabled={!selectedId || busy}
      onclick={confirm}
    >
      Continue in project
    </button>
  {/snippet}
</Modal>
