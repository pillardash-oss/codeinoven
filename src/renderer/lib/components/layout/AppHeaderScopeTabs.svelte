<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { projectIconOnError } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'

  async function switchProject(projectId: string): Promise<void> {
    const project = scopeState.projectRecords.find((p) => p.id === projectId) ?? null
    if (!project) return

    const scopeProject = scopeState.projects.find((p) => p.id === projectId)

    const allThreads: Thread[] = await invoke('thread:listAll')
    const projectThreads = allThreads
      .filter((t) => t.projectId === projectId && !t.archived)
      .filter((t) => !isOrchestrationChildThread(t))
      .sort((a, b) => b.lastActivity - a.lastActivity)

    const activeThread = projectThreads[0] ?? null

    if (activeThread) {
      workspaceState.openThread(activeThread, project, scopeProject?.iconUrl ?? null)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = scopeProject?.iconUrl ?? null
      rendererRecovery.setSelectedProject(projectId)
    }

    scopeState.clearSidebarContext()
    await scopeState.activateProject(projectId)
  }
</script>

<!-- Scope view header area   separator, scrollable tabs, sticky tools -->
<div class="titlebar-no-drag flex min-w-0 flex-1 items-center self-stretch pl-3">
  <!-- Visual separator between nav buttons and scope tabs -->
  <div class="mr-2 h-5 w-px shrink-0 bg-border/50" aria-hidden="true"></div>

  <div
    class="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
    role="tablist"
    aria-label="Project tabs"
    tabindex="0"
  >
    <div class="ml-auto flex h-full w-max items-center gap-0.5">
      {#each scopeState.projects as project (project.id)}
        {@const projectColor = project.color ?? pickColorForSeed(project.id)}
        {@const isActiveProject = scopeState.activeProjectId === project.id}
        <button
          class="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors {isActiveProject
            ? 'bg-foreground font-medium text-app'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          role="tab"
          aria-selected={isActiveProject}
          title={projectIdentityTitle(project)}
          onclick={() => void switchProject(project.id)}
        >
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-raised"
            style:border-color={`color-mix(in srgb, ${projectColor} 45%, transparent)`}
            style:background-color={`color-mix(in srgb, ${projectColor} 6%, var(--color-raised))`}
            aria-hidden="true"
          >
            {#if project.iconUrl}
              <img
                src={project.iconUrl}
                alt=""
                class="h-3.5 w-3.5 object-contain"
                onerror={projectIconOnError(project)}
              />
            {/if}
          </span>
          <ProjectIdentity
            {project}
            class="max-w-36 text-left"
            nameClass="text-xs font-medium"
            locationClass="text-[0.5625rem] text-dimmed"
            showLocation={hasProjectNameCollision(project, scopeState.projects)}
          />
        </button>
      {/each}
    </div>
  </div>
</div>
