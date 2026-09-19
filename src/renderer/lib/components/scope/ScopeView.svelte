<script lang="ts">
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { scopeState, type ThreadStage } from '$lib/stores/scope.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import {
    inheritEngineeringLifecycle,
    persistInheritedThreadSettings,
    settingsForNewThread,
    threadWithInheritedSettings
  } from '$lib/thread-settings-inheritance'
  import { workspaceState, findEmptyNewThread } from '$lib/stores/workspace.svelte'
  import {
    DEFAULT_THREAD_TITLE,
    activeThreadRowId,
    threadTracksReadStatus,
    type Thread
  } from '$shared/types'
  import ScopeBucketView from './ScopeBucket.svelte'
  import ScopeActionsModals from './ScopeActionsModals.svelte'
  import { ScopeActionsController } from './ScopeActionsController.svelte'

  interface Props {
    navigateToScopedThreads?: () => void
  }

  let { navigateToScopedThreads }: Props = $props()

  /** Scope-level actions + their dialogs, shared with the scoped-threads sidebar. */
  const scopeActions = new ScopeActionsController({
    getProjectId: () => scopeState.activeProjectId,
    onNavigateToScopedThreads: () => navigateToScopedThreads?.()
  })

  /** Failures from this view's thread-level actions (open, rename, fork, move, create). */
  let actionError = $state<string | null>(null)

  let activeProject = $derived(
    scopeState.projectRecords.find((project) => project.id === scopeState.activeProjectId) ?? null
  )

  $effect(() => {
    const projectId = scopeState.activeProjectId
    if (!projectId) return
    // Board first, then hydrate the project's full thread list: custom scopes
    // must show every bucket thread even when it is older than the bounded
    // first-paint recent slice, without paging the sidebar first.
    void scopeState.loadBoard(projectId).then(() => {
      void scopeState.ensureScopeBoardThreadsLoaded(projectId)
    })
  })

  // Keep the typed health of every managed worktree on the active board fresh so
  // unhealthy scopes surface repair actions immediately (deduped in the store),
  // and re-read it on entry so switching to a project or scope always reports the
  // live checkout state (throttled per scope, so it never polls).
  $effect(() => {
    const projectId = scopeState.activeProjectId
    const buckets = projectId ? scopeState.boards.get(projectId)?.buckets : undefined
    scopeState.syncBoardWorktreeHealth(projectId, buckets)
    scopeState.revalidateBoardWorktreeHealth(projectId, buckets)
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
    navigateToScopedThreads?.()
    workspaceState.openThread(thread, project)
    if (threadTracksReadStatus(thread)) {
      try {
        const updated = await invoke('thread:markRead', thread.projectId, thread.id)
        scopeState.updateThread(updated)
        workspaceState.updateThread(updated)
      } catch (error) {
        actionError = errorMessage(error, 'The thread could not be opened.')
      }
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
      navigateToScopedThreads?.()
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
    const activeThread = workspaceState.selectedThread
    const inheritedSettings = settingsForNewThread(activeThread, threadSettings.lastUsed)
    const existing = findEmptyNewThread(scopeState.allScopeThreads, activeProject.id, bucketId)
    if (existing) {
      if (workspaceState.selectedThread?.id === existing.id) {
        workspaceState.requestFocusComposer()
      } else {
        try {
          const thread = activeThread?.settings
            ? await invoke(
                'thread:updateSettings',
                existing.projectId,
                existing.id,
                inheritedSettings
              )
            : existing
          scopeState.updateThread(thread)
          scopeState.showSidebarForThread(thread, bucketId)
          navigateToScopedThreads?.()
          if (activeThread) {
            await inheritEngineeringLifecycle(activeProject.id, activeThread.id, thread.id)
          }
          workspaceState.openThread(thread, activeProject)
        } catch (error) {
          actionError = errorMessage(error, 'The thread could not be opened.')
        }
      }
      return
    }
    try {
      const created = await invoke('thread:create', {
        projectId: activeProject.id,
        providerId: 'pi',
        title: DEFAULT_THREAD_TITLE,
        workingDirectory: activeProject.path,
        settings: inheritedSettings,
        scopeBucketId: bucketId
      })
      const thread = activeThread?.settings
        ? threadWithInheritedSettings(created, inheritedSettings)
        : created
      scopeState.updateThread(thread)
      scopeState.showSidebarForThread(thread, bucketId)
      navigateToScopedThreads?.()
      if (activeThread) {
        await inheritEngineeringLifecycle(activeProject.id, activeThread.id, thread.id)
      }
      workspaceState.openThread(thread, activeProject)
      if (activeThread?.settings) {
        void persistInheritedThreadSettings(thread, inheritedSettings).catch((error) => {
          actionError = errorMessage(error, 'The inherited thread settings could not be saved.')
        })
      }
    } catch (error) {
      actionError = errorMessage(error, 'The thread could not be created.')
    }
  }

  function moveBucket(draggedId: string, targetId: string, position: 'before' | 'after'): void {
    void scopeState.reorderBucket(draggedId, targetId, position).catch((error: unknown) => {
      actionError = errorMessage(error, 'The scope could not be moved.')
    })
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
    {#if actionError || scopeActions.error || scopeState.error}
      <div
        class="flex shrink-0 items-center gap-3 border-b bg-danger/10 px-4 py-2 text-xs text-danger"
      >
        <span>{actionError ?? scopeActions.error ?? scopeState.error}</span>
        <button
          class="ml-auto rounded-md px-2 py-1 hover:bg-danger/10"
          aria-label="Dismiss error"
          onclick={() => {
            actionError = null
            scopeActions.dismissError()
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
              actions={scopeActions}
              fill={scopeState.buckets.length === 1}
              activeThreadId={activeThreadRowId(workspaceState.selectedThread)}
              onToggle={() => toggleBucket(bucket.id)}
              onToggleSlice={(stage) => toggleSlice(bucket.id, stage)}
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

<ScopeActionsModals actions={scopeActions} />
