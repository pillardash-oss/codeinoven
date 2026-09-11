<script lang="ts" module>
  /** Everything the composer/host needs to render the scope shoe. */
  export interface ComposerScopeShoe {
    projectId: string
    threadId: string
    bucket: ScopeBucket
    source?: 'local' | 'ssh'
    host?: string
    isNewThread: boolean
    /** While the thread is actively working, scope interactions are inert. */
    isWorking?: boolean
    /** Project identity on the shoe   the project picker stays live only before the first message. */
    project?: ComposerProject
    /** Reassigns the thread's project; only honoured before the first message. */
    onSwitchProject?: (projectId: string) => void
    onOpenScopeView?: () => void | Promise<void>
  }
</script>

<script lang="ts">
  import { ChevronDown, FolderTree, Folder, Globe, GitBranch, Monitor, Search, X } from '@lucide/svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { toast } from 'svelte-sonner'
  import ProjectSwitch from '$lib/components/shared/ProjectSwitch.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import type { ComposerProject } from '$shared/types'
  import ScopeBadge from '$lib/components/shared/ScopeBadge.svelte'
  import ScopeCreateModal from '$lib/components/scope/ScopeCreateModal.svelte'
  import ChangeScopeModal from '$lib/components/threads/ChangeScopeModal.svelte'
  import type { ScopeBucket, ScopeEnvironmentMode } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
    /** The bucket the thread currently belongs to (default when unset). */
    bucket: ScopeBucket
    /** Where the project runs   scope work targets that box. */
    source?: 'local' | 'ssh'
    host?: string
    /** New threads can reassign the scope; existing ones toggle the scope view. */
    isNewThread: boolean
    /** While the thread is actively working, scope interactions are inert. */
    isWorking?: boolean
    /** Project identity on the shoe   the project picker stays live only before the first message. */
    project?: ComposerProject
    /** Reassigns the thread's project; only honoured before the first message. */
    onSwitchProject?: (projectId: string) => void
    /** Opens the projects/threads scope view for this thread (existing threads). */
    onOpenScopeView?: () => void | Promise<void>
  }

  let {
    projectId,
    threadId,
    bucket,
    source,
    host,
    isNewThread,
    isWorking = false,
    project,
    onSwitchProject,
    onOpenScopeView
  }: Props = $props()

  let menuOpen = $state(false)
  let query = $state('')
  let creatingAuto = $state(false)
  let createModalOpen = $state(false)
  /** Full change-scope modal, opened by right-clicking the scope badge. */
  let changeScopeOpen = $state(false)
  let searchInput: HTMLInputElement | undefined = $state(undefined)

  /** Ordered board buckets for the project, minus the current scope. */
  let otherBuckets = $derived(
    (scopeState.boards.get(projectId)?.buckets ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((candidate) => {
        if (candidate.id === bucket.id) return false
        const q = query.trim().toLocaleLowerCase()
        if (!q) return true
        return candidate.name.toLocaleLowerCase().includes(q)
      })
  )

  let noMatch = $derived(otherBuckets.length === 0 && query.trim().length > 0)

  function bucketColor(candidate: ScopeBucket): string {
    return candidate.color ?? pickColorForSeed(candidate.id)
  }

  async function assignScope(bucketId: string): Promise<void> {
    try {
      const updated = await invoke('thread:update', projectId, threadId, {
        scopeBucketId: bucketId
      })
      workspaceState.updateThread(updated)
      scopeState.updateThread(updated)
      menuOpen = false
      query = ''
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The scope could not be changed.')
    }
  }

  /** Create a scope + isolated worktree in one go; the thread lands in the new
   *  scope and the agent performs its work there with the copy environment. */
  async function autoCreateScope(): Promise<void> {
    if (creatingAuto) return
    creatingAuto = true
    const board = scopeState.boards.get(projectId)
    const title = `Auto scope ${board ? board.buckets.length + 1 : 2}`
    scopeState.beginWorktreeCreation(
      projectId,
      {
        title,
        isolated: true,
        runSetup: true,
        environmentMode: 'copy' as ScopeEnvironmentMode
      },
      {
        onCreated: (createdId) => void assignScope(createdId)
      }
    )
    creatingAuto = false
    menuOpen = false
    query = ''
  }

  function toggleMenu(): void {
    if (!isNewThread) {
      menuOpen = false
      void onOpenScopeView?.()
      return
    }
    if (menuOpen) {
      menuOpen = false
      query = ''
      return
    }
    menuOpen = true
    setTimeout(() => searchInput?.focus(), 0)
    void scopeState.ensureBoardLoaded(projectId)
  }

  function closeMenu(): void {
    menuOpen = false
    query = ''
  }

  /** Git remote origin URL for the project, surfaced on the branch pill. */
  let remoteOriginUrl = $derived(projectRemotes.get(projectId) ?? null)
  let branchPillTitle = $derived(
    remoteOriginUrl ?? (project ? projectIdentityTitle(project) : undefined)
  )
  // Resolve the project's Git remote so hovering the branch pill can reveal it.
  $effect(() => {
    const path = project?.path
    if (!projectId || !path) return
    void projectRemotes.ensure(projectId, path)
  })
</script>

<div class="flex min-w-0 items-center gap-1.5">
  <!-- Project scope -->
  <div class="relative min-w-0">
    <button
      type="button"
      class="flex min-w-0 cursor-pointer items-center gap-1 rounded-md transition-opacity hover:opacity-85"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      title={isNewThread
        ? `Change the scope of this new thread   currently ${bucket.name}`
        : `Toggle the scoped views for ${bucket.name}`}
      onclick={toggleMenu}
      oncontextmenu={(event: MouseEvent) => {
        event.preventDefault()
        if (isWorking) return
        changeScopeOpen = true
      }}
      aria-disabled={isWorking}
    >
      {#if bucket.root.kind === 'worktree'}
        <span
          class="flex shrink-0 items-center"
          role="img"
          aria-label="Managed Git worktree scope on {bucket.root.branch}"
          title="Managed Git worktree scope on {bucket.root.branch}"
        >
          <FolderTree size={12} class="text-warning" />
        </span>
      {/if}
      <ScopeBadge {bucket} size="sm" />
      {#if isNewThread}
        <span class="shrink-0 text-dimmed">
          <ChevronDown size={11} />
        </span>
      {/if}
    </button>

    {#if changeScopeOpen}
      <ChangeScopeModal
        open={changeScopeOpen}
        {projectId}
        {threadId}
        currentBucketId={bucket.id}
        onClose={() => (changeScopeOpen = false)}
      />
    {/if}

    {#if isNewThread && menuOpen}
      <button
        class="fixed inset-0 z-30 cursor-default"
        aria-label="Close scope menu"
        onclick={closeMenu}
      ></button>
      <div
        class="absolute bottom-full left-0 z-40 mb-1.5 w-72 overflow-hidden rounded-xl border bg-surface p-1.5 shadow-lg"
        role="menu"
        aria-label="Thread scope"
      >
        <div class="flex items-center gap-2 rounded-lg border bg-elevated px-2.5 py-1.5">
          <Search size={13} class="shrink-0 text-dimmed" />
          <input
            bind:this={searchInput}
            bind:value={query}
            type="text"
            class="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
            placeholder="Search scopes…"
            aria-label="Search scopes"
          />
          {#if query}
            <button
              type="button"
              class="shrink-0 text-dimmed transition-colors hover:text-foreground"
              aria-label="Clear search"
              title="Clear search"
              onclick={() => {
                query = ''
                searchInput?.focus()
              }}
            >
              <X size={12} />
            </button>
          {/if}
        </div>

        <!-- Inherited scope for this new thread -->
        <div class="max-h-60 overflow-y-auto">
          <button
            type="button"
            class="mt-1 flex w-full items-center gap-2 rounded-lg border-l-2 bg-raised px-2.5 py-1.5 text-left text-xs text-foreground"
            style:border-left-color={bucketColor(bucket)}
            title={`Inherited scope: ${bucket.name}`}
            aria-label={`Inherited scope: ${bucket.name}`}
            role="menuitemradio"
            aria-checked="true"
            onclick={closeMenu}
          >
            <span class="min-w-0 flex-1 truncate">{bucket.name}</span>
            <span class="shrink-0 text-[0.625rem] text-dimmed">Inherited</span>
          </button>

          <span
            class="mt-1 block px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
            >Create</span
          >
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated"
            title="Generate a new scope with its own isolated worktree (copy environment)"
            aria-label="Auto create new scope and worktree"
            disabled={creatingAuto}
            onclick={() => void autoCreateScope()}
          >
            <span class="min-w-0 flex-1">Auto create new scope & worktree</span>
            <span class="shrink-0 text-[0.625rem] text-dimmed">Copy env</span>
          </button>
          <button
            type="button"
            class="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated"
            title="Open the full scope creation form"
            aria-label="Create a scope"
            onclick={() => {
              menuOpen = false
              query = ''
              createModalOpen = true
            }}
          >
            Create a scope…
          </button>

          <span
            class="mt-1 block px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
            >Other scopes</span
          >
          {#each otherBuckets as candidate (candidate.id)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg border-l-2 px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
              style:border-left-color={bucketColor(candidate)}
              title={candidate.name}
              onclick={() => void assignScope(candidate.id)}
            >
              <span class="min-w-0 flex-1 truncate">{candidate.name}</span>
            </button>
          {:else}
            <p class="px-2.5 py-3 text-center text-[0.625rem] text-dimmed">
              {noMatch ? 'No other scopes match' : 'No other scopes'}
            </p>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Project identity: live picker before the first message, show-only after -->
  {#if project}
    <ProjectSwitch
      activeProjectId={projectId}
      onSwitch={isNewThread ? onSwitchProject : undefined}
      disabled={!isNewThread}
      side="top"
      align="start"
      class="shoe-project flex max-w-48 min-w-0 items-center gap-2 justify-start"
      ariaLabel={isNewThread
        ? 'Change the project of this new thread'
        : `Project: ${project.name}`}
    >
      {#if project.iconUrl}
        <img src={project.iconUrl} alt="" class="h-4 w-4 shrink-0 rounded" />
      {:else}
        <Folder size={13} class="shrink-0 text-dimmed" />
      {/if}
      <ProjectIdentity
        {project}
        class="shoe-identity min-w-0"
        nameClass="text-xs font-medium text-foreground"
        locationClass="shoe-identity-location text-[0.5625rem] text-dimmed"
        showLocation={hasProjectNameCollision(project, scopeState.projectRecords)}
      />
    </ProjectSwitch>
  {/if}

  <!-- Project type: where the agent's work runs (SSH box support arrives with remote projects) -->
  <span
    class="flex shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted"
    title={source === 'ssh'
      ? `Remote project${host ? ` on ${host}` : ''}   the agent will work on this box`
      : 'Project runs locally on this machine'}
  >
    {#if source === 'ssh'}
      <Globe size={10} class="shrink-0" />
      <span class="max-w-24 truncate">{host ?? 'Remote'}</span>
    {:else}
      <Monitor size={10} class="shrink-0" />
      <span>Local</span>
    {/if}
  </span>

  {#if project?.branch}
    <span
      class="flex min-w-0 shrink items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted"
      title={branchPillTitle}
    >
      <GitBranch size={9} class="shrink-0" />
      <span class="truncate">{project.branch}</span>
    </span>
  {/if}
</div>

{#if createModalOpen}
  <ScopeCreateModal
    open={createModalOpen}
    {projectId}
    onCreated={(createdId) => void assignScope(createdId)}
    onClose={() => (createModalOpen = false)}
  />
{/if}

<style>
  /* The shoe card is the container: as the conversation screen shrinks (e.g.
     a very wide right sidebar), give the truncating stages room in order  
     project name first, then location, connection label, and finally only the
     icons remain. */
  @container (max-width: 400px) {
    .shoe-project {
      max-width: 8rem;
    }

    .shoe-identity :global(.shoe-identity-location) {
      display: none;
    }
  }

  @container (max-width: 320px) {
    .shoe-project {
      max-width: 1.25rem;
    }

    .shoe-identity {
      display: none;
    }
  }
</style>
