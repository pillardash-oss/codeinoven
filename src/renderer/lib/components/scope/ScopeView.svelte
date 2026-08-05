<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { scopeState, type ThreadStage } from '$lib/stores/scope.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { workspaceState, findEmptyNewThread } from '$lib/stores/workspace.svelte'
  import {
    DEFAULT_SCOPE_BUCKET_ID,
    DEFAULT_THREAD_TITLE,
    type ScopeBucket,
    type Thread
  } from '$shared/types'
  import ScopeBucketView from './ScopeBucket.svelte'

  interface Props {
    navigateToProjects?: () => void
  }

  let { navigateToProjects }: Props = $props()

  let editBucketTarget = $state<ScopeBucket | null>(null)
  let editBucketName = $state('')
  let editBucketColor = $state<string | undefined>()
  let editBucketIconType = $state<string | undefined>()
  let deleteBucketTarget = $state<ScopeBucket | null>(null)
  let deleteThreads = $state(false)
  let actionError = $state<string | null>(null)

  let activeProject = $derived(
    scopeState.projectRecords.find((project) => project.id === scopeState.activeProjectId) ?? null
  )

  $effect(() => {
    const projectId = scopeState.activeProjectId
    if (projectId) void scopeState.loadBoard(projectId)
  })

  $effect(() => {
    return subscribe('thread:updated', (...args: unknown[]) => {
      const updated = args[0] as Thread
      if (scopeState.allScopeThreads.some((thread) => thread.id === updated.id)) {
        scopeState.updateThread(updated)
      }
    })
  })

  /** React to Cmd/Ctrl+N (from App.svelte) → create a thread in the targeted bucket. */
  let prevCreateScopeThreadCount = 0
  let creatingScopedThread = false

  $effect(() => {
    const current = scopeState.requestCreateScopedThreadCount
    if (current !== prevCreateScopeThreadCount && !creatingScopedThread) {
      prevCreateScopeThreadCount = current
      const bucketId = scopeState.pendingCreateBucketId
      if (bucketId && activeProject) {
        handleCreateScopedThread(bucketId)
      }
    }
  })

  async function handleCreateScopedThread(bucketId: string): Promise<void> {
    creatingScopedThread = true
    try {
      await createThread(bucketId)
    } finally {
      creatingScopedThread = false
      if (scopeState.requestCreateScopedThreadCount !== prevCreateScopeThreadCount) {
        prevCreateScopeThreadCount = scopeState.requestCreateScopedThreadCount
        const nextBucketId = scopeState.pendingCreateBucketId
        if (nextBucketId && activeProject) {
          handleCreateScopedThread(nextBucketId)
        }
      }
    }
  }

  function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback
  }

  async function openThread(thread: Thread): Promise<void> {
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
    scopeState.showSidebarForThread(thread)
    navigateToProjects?.()
    workspaceState.openThread(thread, project)
    try {
      const updated = await invoke('thread:markRead', thread.projectId, thread.id)
      scopeState.updateThread(updated)
      workspaceState.updateThread(updated)
    } catch (error) {
      actionError = errorMessage(error, 'The thread could not be opened.')
    }
  }

  async function handleRename(thread: Thread, newName: string): Promise<void> {
    const updated = await invoke('thread:update', thread.projectId, thread.id, {
      title: newName,
      titleSource: 'manual'
    })
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
  }

  async function togglePin(thread: Thread): Promise<void> {
    try {
      const updated = await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
      scopeState.updateThread(updated)
      workspaceState.updateThread(updated)
    } catch (error) {
      actionError = errorMessage(error, 'The thread pin could not be changed.')
    }
  }

  async function forkThread(thread: Thread): Promise<void> {
    try {
      const forked = await invoke(
        'thread:fork',
        thread.projectId,
        thread.id,
        `${thread.title} (fork)`
      )
      scopeState.updateThread(forked)
      const project =
        scopeState.projectRecords.find((candidate) => candidate.id === forked.projectId) ?? null
      scopeState.showSidebarForThread(forked)
      navigateToProjects?.()
      workspaceState.openThread(forked, project)
    } catch (error) {
      actionError = errorMessage(error, 'The thread could not be forked.')
    }
  }

  async function handleDelete(thread: Thread): Promise<void> {
    await invoke('thread:delete', thread.projectId, thread.id)
    scopeState.removeThread(thread.id)
    if (workspaceState.selectedThread?.id === thread.id) {
      workspaceState.clearThread()
    }
  }

  async function moveThread(threadId: string, bucketId: string): Promise<void> {
    const thread = scopeState.allScopeThreads.find((candidate) => candidate.id === threadId)
    if (!thread || scopeState.bucketForThread(thread) === bucketId) return
    try {
      const updated = await invoke('thread:update', thread.projectId, thread.id, {
        scopeBucketId: bucketId
      })
      scopeState.updateThread(updated)
      workspaceState.updateThread(updated)
    } catch (error) {
      actionError = errorMessage(error, 'The thread could not be moved.')
    }
  }

  async function reorderThread(
    bucketId: string,
    stage: ThreadStage,
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const dragged = scopeState.allScopeThreads.find((thread) => thread.id === draggedId)
    if (!dragged) return
    if (
      scopeState.bucketForThread(dragged) !== bucketId ||
      scopeState.stageForThread(dragged) !== stage
    ) {
      await moveThread(draggedId, bucketId)
      return
    }
    try {
      await scopeState.reorderThreads(bucketId, stage, draggedId, targetId, position)
    } catch (error) {
      actionError = errorMessage(error, 'The scope thread order could not be saved.')
    }
  }

  async function createThread(bucketId: string): Promise<void> {
    if (!activeProject) return
    const existing = findEmptyNewThread(scopeState.allScopeThreads, activeProject.id, bucketId)
    if (existing) {
      if (workspaceState.selectedThread?.id === existing.id) {
        workspaceState.requestFocusComposer()
      } else {
        scopeState.showSidebarForThread(existing, bucketId)
        navigateToProjects?.()
        workspaceState.openThread(existing, activeProject)
      }
      return
    }
    try {
      const thread = await invoke('thread:create', {
        projectId: activeProject.id,
        providerId: 'opencode',
        title: DEFAULT_THREAD_TITLE,
        workingDirectory: activeProject.path,
        settings: { ...threadSettings.lastUsed },
        scopeBucketId: bucketId
      })
      scopeState.updateThread(thread)
      scopeState.showSidebarForThread(thread, bucketId)
      navigateToProjects?.()
      workspaceState.openThread(thread, activeProject)
    } catch (error) {
      actionError = errorMessage(error, 'The thread could not be created.')
    }
  }

  function askEditBucket(bucket: ScopeBucket): void {
    editBucketTarget = bucket
    editBucketName = bucket.name
    editBucketColor = bucket.color
    editBucketIconType = bucket.iconType
  }

  async function confirmEditBucket(): Promise<void> {
    if (!editBucketTarget || !editBucketName.trim()) return
    try {
      await scopeState.editBucket(editBucketTarget.id, {
        name: editBucketName,
        color: editBucketColor,
        iconType: editBucketIconType
      })
      editBucketTarget = null
    } catch (error) {
      actionError = errorMessage(error, 'The scope could not be edited.')
    }
  }

  function moveBucket(draggedId: string, targetId: string, position: 'before' | 'after'): void {
    void scopeState.reorderBucket(draggedId, targetId, position).catch((error: unknown) => {
      actionError = errorMessage(error, 'The scope could not be moved.')
    })
  }

  async function confirmDeleteBucket(): Promise<void> {
    if (!deleteBucketTarget || deleteBucketTarget.id === DEFAULT_SCOPE_BUCKET_ID) return
    try {
      const affectedThreads = scopeState.currentProjectThreads.filter(
        (thread) => scopeState.bucketForThread(thread) === deleteBucketTarget?.id
      )
      if (deleteThreads) {
        await Promise.all(
          affectedThreads.map((thread) => invoke('thread:delete', thread.projectId, thread.id))
        )
        for (const thread of affectedThreads) {
          scopeState.removeThread(thread.id)
          if (workspaceState.selectedThread?.id === thread.id) {
            workspaceState.clearThread()
          }
        }
      } else {
        const reassigned = await Promise.all(
          affectedThreads.map((thread) =>
            invoke('thread:update', thread.projectId, thread.id, {
              scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
            })
          )
        )
        for (const thread of reassigned) {
          scopeState.updateThread(thread)
          workspaceState.updateThread(thread)
        }
      }
      await scopeState.removeBucket(deleteBucketTarget.id)
      deleteBucketTarget = null
      deleteThreads = false
    } catch (error) {
      actionError = errorMessage(error, 'The scope could not be deleted.')
    }
  }

  function toggleBucket(bucketId: string): void {
    void scopeState.toggleBucket(bucketId).catch((error: unknown) => {
      actionError = errorMessage(error, 'The scope could not be folded.')
    })
  }

  function toggleSlice(bucketId: string, stage: ThreadStage): void {
    void scopeState.toggleSlice(bucketId, stage).catch((error: unknown) => {
      actionError = errorMessage(error, 'The slice could not be folded.')
    })
  }
</script>

<div class="flex h-full flex-col overflow-hidden bg-app">
  {#if !scopeState.activeProjectId}
    <div class="flex h-full items-center justify-center">
      <p class="text-sm text-dimmed">Select a project to organize its threads by scope.</p>
    </div>
  {:else}
    {#if actionError || scopeState.error}
      <div
        class="flex shrink-0 items-center gap-3 border-b bg-danger/10 px-4 py-2 text-xs text-danger"
      >
        <span>{actionError ?? scopeState.error}</span>
        <button
          class="ml-auto rounded-md px-2 py-1 hover:bg-danger/10"
          aria-label="Dismiss error"
          onclick={() => {
            actionError = null
            scopeState.error = null
          }}
        >
          Dismiss
        </button>
      </div>
    {/if}

    {#if scopeState.loading}
      <div class="flex flex-1 items-center justify-center">
        <p class="text-sm text-dimmed">Loading scopes…</p>
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-auto p-3">
        <div
          class={scopeState.buckets.length === 1
            ? 'h-full w-full'
            : 'grid w-full grid-cols-2 items-start gap-3'}
        >
          {#each scopeState.buckets as bucket (bucket.id)}
            <ScopeBucketView
              {bucket}
              fill={scopeState.buckets.length === 1}
              selectedThreadId={workspaceState.selectedThread?.id ?? null}
              onToggle={() => toggleBucket(bucket.id)}
              onToggleSlice={(stage) => toggleSlice(bucket.id, stage)}
              onEditBucket={() => askEditBucket(bucket)}
              onDeleteBucket={() => (deleteBucketTarget = bucket)}
              onMoveBucket={moveBucket}
              onCreateThread={() => void createThread(bucket.id)}
              onOpen={(thread) => void openThread(thread)}
              onRename={handleRename}
              onTogglePin={(thread) => void togglePin(thread)}
              onDelete={handleDelete}
              onFork={(thread) => void forkThread(thread)}
              onMoveThread={(threadId, bucketId) => void moveThread(threadId, bucketId)}
              onReorderThread={(stage, draggedId, targetId, position) =>
                void reorderThread(bucket.id, stage, draggedId, targetId, position)}
            />
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<Modal
  open={editBucketTarget !== null}
  title="Edit Scope"
  onClose={() => (editBucketTarget = null)}
>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={() => (editBucketTarget = null)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form="edit-scope-form"
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={!editBucketName.trim() || scopeState.saving}
    >
      Save
    </button>
  {/snippet}

  <form
    id="edit-scope-form"
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void confirmEditBucket()
    }}
  >
    <AppearancePicker
      name={editBucketName}
      color={editBucketColor}
      iconType={editBucketIconType}
      onColorChange={(color) => (editBucketColor = color)}
      onIconTypeChange={(iconType) => (editBucketIconType = iconType)}
      onReset={() => {
        editBucketColor = undefined
        editBucketIconType = undefined
      }}
    />
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="edit-scope-name">Name</label>
      <input
        id="edit-scope-name"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
        bind:value={editBucketName}
      />
    </div>
  </form>
</Modal>

<Modal
  open={deleteBucketTarget !== null}
  title="Delete Scope"
  onClose={() => (deleteBucketTarget = null)}
>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={() => (deleteBucketTarget = null)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-on-danger hover:bg-danger-hover"
      onclick={() => void confirmDeleteBucket()}
    >
      Delete
    </button>
  {/snippet}

  <p class="text-sm leading-relaxed text-muted">
    Delete <span class="font-medium text-foreground">{deleteBucketTarget?.name}</span>? {deleteThreads
      ? 'Its threads will be permanently deleted.'
      : 'Its threads will return to Default.'}
  </p>

  <div class="mt-4 flex items-center justify-between rounded-lg border bg-elevated/50 px-3 py-2.5">
    <div class="min-w-0">
      <p class="text-sm font-medium text-foreground">Delete associated threads</p>
      <p class="text-xs text-muted">Also permanently delete every thread in this scope.</p>
    </div>
    <Switch
      checked={deleteThreads}
      onchange={(checked) => (deleteThreads = checked)}
      activeClass="bg-danger"
      aria-label="Delete associated threads"
    />
  </div>
</Modal>
