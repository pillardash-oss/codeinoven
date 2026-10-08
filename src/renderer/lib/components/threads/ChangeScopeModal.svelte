<script lang="ts">
  import { X, Search, Check, Plus } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import Modal from '../ui/Modal.svelte'
  import ScopeCreateModal from '../scope/ScopeCreateModal.svelte'
  import { getIconSvgDataUrl, generateInitialsIconSvg } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { ScopeBucket } from '$shared/types'

  interface Props {
    open: boolean
    onClose: () => void
    threadId: string
    projectId: string
    currentBucketId: string
  }

  let { open, onClose, threadId, projectId, currentBucketId }: Props = $props()

  let query = $state('')
  let searchInput: HTMLInputElement | undefined = $state(undefined)
  let loadError = $state('')
  /** Seed for the canonical scope creation modal when the query is a miss. */
  let createModalOpen = $state(false)
  /**
   * Where a scope produced by the create flow must land: frozen the moment the
   * run starts and never read back from the props, because that run outlives this
   * dialog and the props keep tracking whichever thread and project the user is
   * on by the time the job finishes.
   */
  let creationTarget: { projectId: string; threadId: string } | null = $state(null)

  let buckets = $derived(
    (scopeState.boards.get(projectId)?.buckets ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((bucket) => {
        const q = query.trim().toLowerCase()
        if (!q) return true
        return bucket.name.toLowerCase().includes(q)
      })
  )

  /** The typed query matches no existing scope, so a "+" appears to create it. */
  let noMatch = $derived(query.trim().length > 0 && buckets.length === 0)

  /** Point one thread at a scope and keep both stores in step. It throws so each
   *  caller can surface the failure wherever the user still is. */
  async function applyScopeToThread(
    targetProjectId: string,
    targetThreadId: string,
    bucketId: string
  ): Promise<void> {
    const updated = await invoke('thread:update', targetProjectId, targetThreadId, {
      scopeBucketId: bucketId
    })
    workspaceState.updateThread(updated)
    scopeState.updateThread(updated)
  }

  async function selectBucket(bucket: ScopeBucket): Promise<void> {
    try {
      await applyScopeToThread(projectId, threadId, bucket.id)
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Failed to change scope'
      return
    }
    onClose()
  }

  /** Open the canonical new-scope flow (worktree option included) seeded with
   *  the typed query instead of creating a scope directly. */
  function openCreateModal(): void {
    // Freeze here, not when the dock job starts: the form outlives this dialog
    // and the props keep tracking the selected thread while it is open.
    creationTarget = { projectId, threadId }
    createModalOpen = true
  }

  /**
   * Plain Enter in the search field is the keyboard twin of the `+` button:
   * with no match it opens the create flow seeded with the query, so the whole
   * "type a new scope and create it" flow is reachable without the mouse.
   * Enter keeps its input-method meaning while text is being composed (IME),
   * and does nothing when the query does match an existing scope.
   */
  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || !noMatch) return
    event.preventDefault()
    openCreateModal()
  }

  /** Apply a freshly created scope to the thread this flow was started for. */
  async function assignCreatedScope(bucketId: string): Promise<void> {
    const target = creationTarget
    if (!target) return
    creationTarget = null
    try {
      await applyScopeToThread(target.projectId, target.threadId, bucketId)
    } catch (error) {
      // The dialog is long gone by now: the run reports into the scope dock and
      // the user has moved on, so the failure has to reach them where they are.
      toast.error(
        error instanceof Error
          ? error.message
          : 'The thread could not be moved into the created scope'
      )
    }
  }

  /**
   * Creating a scope is a dock job, so launching it dismisses this dialog along
   * with the form that started it: the run reports its stages in the scope dock
   * for as long as it needs, and the user is never parked on a search that cannot
   * match anything until a worktree finishes. The target thread was frozen when
   * the form opened, while the dialog still belonged to the thread being changed.
   */
  function handleCreateStarted(): void {
    onClose()
  }
</script>

<!-- The shared Modal is the bits-ui Dialog wrapper: it owns the overlay, the
     backdrop, Escape handling, and the initial focus, which lands on the first
     input field   this modal's search bar   so typing can start immediately. -->
<Modal {open} title="Change Scope" {onClose}>
  <div class="space-y-3">
    <div class="flex items-center gap-2 rounded-lg border bg-elevated px-3 py-2">
      <Search size={14} class="shrink-0 text-dimmed" />
      <input
        bind:this={searchInput}
        bind:value={query}
        onkeydown={handleSearchKeydown}
        type="text"
        inputmode="search"
        class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-dimmed"
        placeholder="Search scopes..."
        aria-label="Search scopes"
      />
      {#if noMatch}
        <button
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Create scope {query.trim()}"
          title="Create scope {query.trim()}"
          onclick={openCreateModal}
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      {/if}
      {#if query}
        <button
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
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

    {#if loadError}
      <p class="text-xs text-danger">{loadError}</p>
    {/if}
    <div class="max-h-72 space-y-0.5 overflow-y-auto">
      {#each buckets as bucket (bucket.id)}
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors {bucket.id ===
          currentBucketId
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          title={bucket.name}
          disabled={bucket.id === currentBucketId}
          onclick={() => void selectBucket(bucket)}
        >
          {#if bucket.iconType}
            <img
              src={getIconSvgDataUrl(bucket.iconType, bucket.color ?? pickColorForSeed(bucket.id))}
              alt=""
              class="h-4 w-4 shrink-0 object-contain"
              draggable="false"
            />
          {:else if bucket.color}
            <img
              src={generateInitialsIconSvg(bucket.name, bucket.color)}
              alt=""
              class="h-4 w-4 shrink-0 object-contain"
              draggable="false"
            />
          {:else}
            <span class="h-4 w-4 shrink-0 rounded-full bg-dimmed/20"></span>
          {/if}
          <span class="flex-1 truncate">{bucket.name}</span>
          {#if bucket.id === currentBucketId}
            <span class="flex shrink-0 items-center gap-1 text-[0.625rem] text-dimmed">
              <Check size={10} />
              Current
            </span>
          {/if}
        </button>
      {:else}
        <p class="py-8 text-center text-xs text-dimmed">
          {noMatch ? 'No scopes match - press Enter or + to create one' : 'No scopes found'}
        </p>
      {/each}
    </div>
  </div>
</Modal>

<!-- Mounted only while open so the typed query seeds the New Scope form on
     every launch   a persistent instance would freeze `initialName` at its
     first (empty) mount and force a retype. It is a sibling of the shared
     Modal, which is safe: bits-ui keeps one global layer stack, so the nested
     dialog owns Escape and outside interaction while it is up and this modal
     keeps the typed query. Cancelling the form returns here with that query
     intact; creating dismisses the whole flow, because the run it starts reports
     in the scope dock instead of in this dialog. -->
{#if createModalOpen}
  <ScopeCreateModal
    open={createModalOpen}
    {projectId}
    targetThreadId={creationTarget?.threadId ?? threadId}
    initialName={query.trim()}
    onStarted={handleCreateStarted}
    onCreated={(bucketId) => void assignCreatedScope(bucketId)}
    onClose={() => (createModalOpen = false)}
  />
{/if}
