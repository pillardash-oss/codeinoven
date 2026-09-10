<script lang="ts" module>
  /** Everything the composer/host needs to render the scope shoe. */
  export interface ComposerScopeShoe {
    projectId: string
    threadId: string
    bucket: ScopeBucket
    source?: 'local' | 'ssh'
    host?: string
    isNewThread: boolean
    onOpenScopeView?: () => void | Promise<void>
  }
</script>

<script lang="ts">
  import { ChevronDown, Globe, Monitor, Search, X } from '@lucide/svelte'
  import { getIconSvgDataUrl, generateInitialsIconSvg } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { toast } from 'svelte-sonner'
  import ScopeBadge from '$lib/components/shared/ScopeBadge.svelte'
  import ScopeCreateModal from '$lib/components/scope/ScopeCreateModal.svelte'
  import type { ScopeBucket, ScopeEnvironmentMode } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
    /** The bucket the thread currently belongs to (default when unset). */
    bucket: ScopeBucket
    /** Where the project runs — scope work targets that box. */
    source?: 'local' | 'ssh'
    host?: string
    /** New threads can reassign the scope; existing ones toggle the scope view. */
    isNewThread: boolean
    /** Opens the projects/threads scope view for this thread (existing threads). */
    onOpenScopeView?: () => void | Promise<void>
  }

  let { projectId, threadId, bucket, source, host, isNewThread, onOpenScopeView }: Props =
    $props()

  let menuOpen = $state(false)
  let query = $state('')
  let creatingAuto = $state(false)
  let createModalOpen = $state(false)
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

  function iconSourceFor(candidate: ScopeBucket): string | null {
    const color = bucketColor(candidate)
    if (candidate.iconType) return getIconSvgDataUrl(candidate.iconType, color)
    if (candidate.color) return generateInitialsIconSvg(candidate.name, color)
    return null
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
        ? `Change the scope of this new thread — currently ${bucket.name}`
        : `Toggle the scoped views for ${bucket.name}`}
      onclick={toggleMenu}
    >
      <ScopeBadge {bucket} size="sm" />
      {#if isNewThread}
        <span class="shrink-0 text-dimmed">
          <ChevronDown size={11} />
        </span>
      {/if}
    </button>

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
            {#if iconSourceFor(bucket)}
              <img src={iconSourceFor(bucket)} alt="" class="h-4 w-4 shrink-0 object-contain" draggable="false" />
            {/if}
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
              {#if iconSourceFor(candidate)}
                <img src={iconSourceFor(candidate)} alt="" class="h-4 w-4 shrink-0 object-contain" draggable="false" />
              {/if}
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

  <!-- Project type: where the agent's work runs (SSH box support arrives with remote projects) -->
  <span
    class="flex shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted"
    title={source === 'ssh'
      ? `Remote project${host ? ` on ${host}` : ''} — the agent will work on this box`
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
</div>

{#if createModalOpen}
  <ScopeCreateModal
    open={createModalOpen}
    {projectId}
    onCreated={(createdId) => void assignScope(createdId)}
    onClose={() => (createModalOpen = false)}
  />
{/if}
