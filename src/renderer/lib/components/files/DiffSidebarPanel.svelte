<script lang="ts">
  import { ChevronLeft, ChevronRight, FileDiff, Loader2, RefreshCw } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import Switch from '../ui/Switch.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import type { AgentEvent, TurnCheckpointSummary } from '$shared/types'

  interface Props {
    projectId: string
    projectName: string
    threadId: string
    checkpointId: string | null
  }

  let { projectId, projectName, threadId, checkpointId }: Props = $props()

  let checkpoints = $state<TurnCheckpointSummary[]>([])
  let selectedCheckpointId = $state<string | null>(null)
  let loading = $state(false)
  let error = $state('')
  let restoringId = $state<string | null>(null)
  let selections = $state<Record<string, string[]>>({})
  const turns = $derived(checkpoints.filter((checkpoint) => checkpoint.status !== 'active'))
  const selectedIndex = $derived(
    Math.max(
      0,
      turns.findIndex((checkpoint) => checkpoint.id === selectedCheckpointId)
    )
  )
  const selectedCheckpoint = $derived(turns[selectedIndex] ?? null)

  function filename(path: string): string {
    return path.split('/').at(-1) ?? path
  }

  function isMarkdown(path: string): boolean {
    return /\.(?:md|mdown|markdown)$/iu.test(path)
  }

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
  }

  async function refresh(preferredCheckpointId = selectedCheckpointId): Promise<void> {
    loading = true
    error = ''
    try {
      checkpoints = await invoke('checkpoint:list', projectId, threadId)
      selectedCheckpointId =
        turns.find((checkpoint) => checkpoint.id === preferredCheckpointId)?.id ??
        turns[0]?.id ??
        null
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Change history could not be loaded.'
    } finally {
      loading = false
    }
  }

  function selectTurn(index: number): void {
    const checkpoint = turns[index]
    if (checkpoint) selectedCheckpointId = checkpoint.id
  }

  async function openChange(checkpointId: string, path: string): Promise<void> {
    await projectFilesWorkspace.loadDirectory(projectId, '')
    contextSidebarState.openFiles(projectId, threadId)
    await projectFilesWorkspace.openCheckpointFile(projectId, checkpointId, path, 'diff')
  }

  function toggleSelection(checkpointId: string, path: string): void {
    const selected = new SvelteSet(selections[checkpointId] ?? [])
    if (selected.has(path)) selected.delete(path)
    else selected.add(path)
    selections = { ...selections, [checkpointId]: [...selected] }
  }

  async function restoreSelected(checkpointId: string): Promise<void> {
    const paths = selections[checkpointId] ?? []
    if (paths.length === 0) return
    restoringId = checkpointId
    error = ''
    try {
      checkpoints = await invoke(
        'checkpoint:rollbackPaths',
        projectId,
        threadId,
        checkpointId,
        paths
      )
      selections = { ...selections, [checkpointId]: [] }
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Selected files could not be restored.'
    } finally {
      restoringId = null
    }
  }

  async function restoreRun(checkpointId: string): Promise<void> {
    if (!window.confirm('Restore every file in this run to its pre-run state?')) return
    restoringId = checkpointId
    error = ''
    try {
      checkpoints = await invoke('checkpoint:rollback', projectId, threadId, checkpointId)
      selections = { ...selections, [checkpointId]: [] }
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'The run could not be restored.'
    } finally {
      restoringId = null
    }
  }

  $effect(() => {
    const preferredCheckpointId = checkpointId
    void refresh(preferredCheckpointId)
  })

  onMount(() =>
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent
      if (
        event.type === 'checkpoint.updated' &&
        event.projectId === projectId &&
        event.threadId === threadId
      ) {
        void refresh()
      }
    })
  )
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
    <FileDiff size={13} class="shrink-0 text-muted" />
    <span class="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
      {projectName} changes
    </span>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      aria-label="Refresh change history"
      title="Refresh changes"
      disabled={loading}
      onclick={() => void refresh()}
    >
      <RefreshCw size={13} class={loading ? 'animate-spin' : ''} />
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-auto p-2">
    {#if loading && turns.length === 0}
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-dimmed">
        <Loader2 size={14} class="animate-spin" />
        Loading changes
      </div>
    {:else if error}
      <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2">
        <p class="text-[11px] leading-relaxed text-danger">{error}</p>
      </div>
    {:else if turns.length === 0}
      <div class="flex h-full items-center justify-center px-6 text-center">
        <div>
          <FileDiff size={22} class="mx-auto mb-2 text-dimmed" />
          <p class="text-xs font-medium text-muted">No recorded changes</p>
          <p class="mt-1 text-[10px] text-dimmed">Completed runs will appear here.</p>
        </div>
      </div>
    {:else}
      {@const checkpoint = selectedCheckpoint}
      {#if checkpoint}
        <div class="space-y-2">
          <div
            class="flex h-8 items-center justify-between rounded-lg border border-border bg-surface px-1"
          >
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Show previous turn"
              title="Previous turn"
              disabled={selectedIndex >= turns.length - 1}
              onclick={() => selectTurn(selectedIndex + 1)}
            >
              <ChevronLeft size={13} />
            </button>
            <span class="text-[10px] font-medium tabular-nums text-muted">
              Turn {turns.length - selectedIndex} of {turns.length}
            </span>
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Show next turn"
              title="Next turn"
              disabled={selectedIndex <= 0}
              onclick={() => selectTurn(selectedIndex - 1)}
            >
              <ChevronRight size={13} />
            </button>
          </div>

          <section class="rounded-lg border border-border bg-surface">
            <div class="flex min-h-10 items-center gap-2 px-3 py-2">
              <FileDiff size={13} class="shrink-0 text-info" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[11px] font-medium text-foreground">
                  {checkpoint.label}
                </span>
                <span class="block text-[9px] text-dimmed">
                  {formatDate(checkpoint.completedAt ?? checkpoint.createdAt)}
                </span>
              </span>
              <span class="tabular-nums text-[10px] text-dimmed">
                {checkpoint.changes.length}
              </span>
            </div>
            <div class="border-t border-border py-1">
              {#if checkpoint.failure}
                <p class="px-3 py-1.5 text-[10px] leading-relaxed text-danger">
                  {checkpoint.failure}
                </p>
              {/if}
              {#if checkpoint.changes.length === 0}
                <p class="px-3 py-2 text-[10px] text-dimmed">No file changes detected.</p>
              {:else}
                {#each checkpoint.changes as change (`${change.kind}:${change.path}`)}
                  <div class="flex h-8 items-center gap-2 px-3 transition-colors hover:bg-elevated">
                    {#if checkpoint.status !== 'rolled_back'}
                      <Switch
                        checked={(selections[checkpoint.id] ?? []).includes(change.path)}
                        disabled={checkpoint.rolledBackPaths?.includes(change.path)}
                        aria-label={`Select ${change.path} to restore`}
                        onchange={() => toggleSelection(checkpoint.id, change.path)}
                      />
                    {/if}
                    <span
                      class={[
                        'w-4 shrink-0 text-center font-mono text-[10px] font-semibold',
                        change.kind === 'created'
                          ? 'text-success'
                          : change.kind === 'deleted'
                            ? 'text-danger'
                            : 'text-warning'
                      ]}
                    >
                      {change.kind === 'created' ? 'A' : change.kind === 'deleted' ? 'D' : 'M'}
                    </span>
                    <FileTypeIcon path={change.path} />
                    <button
                      type="button"
                      class="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-muted hover:text-foreground"
                      title={`Open ${change.path}`}
                      onclick={() => void openChange(checkpoint.id, change.path)}
                    >
                      {isMarkdown(change.path) ? filename(change.path) : change.path}
                    </button>
                    {#if change.binary}
                      <span class="text-[9px] text-dimmed">binary</span>
                    {/if}
                  </div>
                {/each}
                {#if checkpoint.status !== 'rolled_back'}
                  <div class="flex items-center gap-2 border-t border-border px-3 py-2">
                    <button
                      type="button"
                      class="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                      disabled={restoringId === checkpoint.id ||
                        (selections[checkpoint.id] ?? []).length === 0}
                      onclick={() => void restoreSelected(checkpoint.id)}
                    >
                      Restore selected
                    </button>
                    <button
                      type="button"
                      class="rounded-md px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
                      disabled={restoringId === checkpoint.id}
                      onclick={() => void restoreRun(checkpoint.id)}
                    >
                      {restoringId === checkpoint.id ? 'Restoring…' : 'Restore run'}
                    </button>
                  </div>
                {/if}
              {/if}
            </div>
          </section>
        </div>
      {/if}
    {/if}
  </div>
</div>
