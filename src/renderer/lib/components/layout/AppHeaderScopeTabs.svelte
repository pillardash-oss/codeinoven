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
    <!-- `w-max max-w-full` is the shrink-before-scroll primitive: the row takes
         its content width when it fits, but is capped at the viewport width when
         it does not, so tabs shrink and their project names keep truncating down
         to the icon-only floor before the row overflows into a horizontal scroll.
         `w-max` alone would skip straight to scrolling, and `w-fit` cannot be
         used because the row's intrinsic min-content still counts the
         untruncated labels, which makes it clamp straight back to max-content. -->
    <div class="ml-auto flex h-full w-max max-w-full items-center gap-0.5">
      {#each scopeState.projects as project (project.id)}
        {@const projectColor = project.color ?? pickColorForSeed(project.id)}
        {@const isActiveProject = scopeState.activeProjectId === project.id}
        <!-- min-w is the icon-only floor: 1.25rem icon + 0.25rem gap + 1rem
             horizontal padding. The button shrinks to it as its name is
             truncated, then the row scrolls. `overflow-hidden` keeps the active
             underline inside the rounded corners. -->
        <button
          class="relative flex min-h-8 min-w-[2.5rem] items-center gap-1 overflow-hidden rounded-md px-2 py-0.5 transition-colors {isActiveProject
            ? 'bg-selected text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          role="tab"
          aria-selected={isActiveProject}
          title={projectIdentityTitle(project)}
          onclick={() => void switchProject(project.id)}
        >
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md"
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
            nameClass="text-[0.6875rem] font-medium"
            locationClass="text-[0.5rem] text-dimmed"
            showLocation={hasProjectNameCollision(project, scopeState.projects)}
          />
          <!-- The active tab is marked by the current-row surface plus a bottom
               rule, never a filled block: on dark it is the light rule, on
               light the dark one. -->
          {#if isActiveProject}
            <span
              class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground"
              aria-hidden="true"
            ></span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>
