<script lang="ts">
  import { X, Search, Check, Plus } from '@lucide/svelte'
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

  async function selectBucket(bucket: ScopeBucket): Promise<void> {
    try {
      const updated = await invoke('thread:update', projectId, threadId, {
        scopeBucketId: bucket.id
      })
      workspaceState.updateThread(updated)
      scopeState.updateThread(updated)
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Failed to change scope'
      return
    }
    onClose()
  }

  /** Open the canonical new-scope flow (worktree option included) seeded with
   *  the typed query instead of creating a scope directly. */
  function openCreateModal(): void {
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

  /** Apply a freshly created scope from the creation modal to the thread. */
  async function selectCreatedScope(bucketId: string): Promise<void> {
    createModalOpen = false
    const bucket = (scopeState.boards.get(projectId)?.buckets ?? []).find(
      (candidate) => candidate.id === bucketId
    )
    if (!bucket) {
      loadError = 'The created scope could not be found.'
      return
    }
    await selectBucket(bucket)
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
     keeps the typed query. -->
{#if createModalOpen}
  <ScopeCreateModal
    open={createModalOpen}
    {projectId}
    initialName={query.trim()}
    onCreated={(bucketId) => void selectCreatedScope(bucketId)}
    onClose={() => (createModalOpen = false)}
  />
{/if}
