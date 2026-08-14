<script lang="ts">
  import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Eye,
    FileDiff,
    Loader2,
    RefreshCw
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import FileDiffView from './FileDiffView.svelte'
  import Switch from '../ui/Switch.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import { diffDetails } from './file-diff'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import type { AgentEvent, TurnCheckpointFileDiff, TurnCheckpointSummary } from '$shared/types'

  type ChangesMode = 'diffs' | 'files'

  interface Props {
    projectId: string
    threadId: string
    checkpointId: string | null
    /** File to reveal (scroll + highlight) when the Changes tab opens. */
    revealPath?: string | null
    /** Bumped on each reveal so re-clicking the same file re-triggers. */
    revealNonce?: number
  }

  let { projectId, threadId, checkpointId, revealPath = null, revealNonce = 0 }: Props = $props()

  let checkpoints = $state<TurnCheckpointSummary[]>([])
  let selectedCheckpointId = $state<string | null>(null)
  let loading = $state(false)
  let error = $state('')
  let restoringId = $state<string | null>(null)
  let selections = $state<Record<string, string[]>>({})
  let mode = $state<ChangesMode>('diffs')
  let fileDiffs = $state<TurnCheckpointFileDiff[]>([])
  let loadingDiffs = $state(false)
  let expandedDiffs = $state<Record<string, boolean>>({})
  let flashPath = $state<string | null>(null)
  let scrollContainer = $state<HTMLElement | null>(null)
  let loadedDiffKey: string | null = null
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

  function toggleDiff(path: string): void {
    expandedDiffs = { ...expandedDiffs, [path]: !(expandedDiffs[path] ?? true) }
  }

  $effect(() => {
    const checkpoint = selectedCheckpoint
    if (!checkpoint) {
      fileDiffs = []
      loadedDiffKey = null
      return
    }
    const key = checkpoint.id
    if (loadedDiffKey === key) return
    loadedDiffKey = key
    fileDiffs = []
    loadingDiffs = true
    let cancelled = false
    void Promise.allSettled(
      checkpoint.changes.map((change) =>
        invoke('checkpoint:diff', projectId, threadId, checkpoint.id, change.path)
      )
    ).then((results) => {
      if (cancelled) return
      fileDiffs = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value as TurnCheckpointFileDiff] : []
      )
      expandedDiffs = results.reduce<Record<string, boolean>>(
        (next, result) => {
          if (result.status === 'fulfilled') {
            const path = (result.value as TurnCheckpointFileDiff).path
            if (!(path in next)) next[path] = true
          }
          return next
        },
        { ...expandedDiffs }
      )
      loadingDiffs = false
    })
    return () => {
      cancelled = true
      loadingDiffs = false
    }
  })

  $effect(() => {
    const preferredCheckpointId = checkpointId
    void refresh(preferredCheckpointId)
  })

  $effect(() => {
    const target = revealPath
    if (!target || revealNonce <= 0) return
    if (!fileDiffs.some((diff) => diff.path === target)) return
    const el = scrollContainer?.querySelector<HTMLElement>(
      `[data-reveal-path="${CSS.escape(target)}"]`
    )
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    flashPath = target
    const timer = setTimeout(() => {
      if (flashPath === target) flashPath = null
    }, 1600)
    return () => clearTimeout(timer)
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
  {#if turns.length > 0}
    <div class="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
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
  {/if}

  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
    <div
      class="flex items-center rounded-md bg-elevated p-0.5"
      role="group"
      aria-label="Changes view"
    >
      <button
        type="button"
        class={[
          'flex h-6 items-center gap-1.5 rounded px-2.5 text-[10px] font-medium transition-colors',
          mode === 'diffs' ? 'bg-overlay text-foreground' : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={mode === 'diffs'}
        title="Show each file's diff stacked by file"
        onclick={() => (mode = 'diffs')}
      >
        Diffs
      </button>
      <button
        type="button"
        class={[
          'flex h-6 items-center gap-1.5 rounded px-2.5 text-[10px] font-medium transition-colors',
          mode === 'files' ? 'bg-overlay text-foreground' : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={mode === 'files'}
        title="Show the list of changed files with restore options"
        onclick={() => (mode = 'files')}
      >
        File List
      </button>
    </div>
    <span class="flex-1"></span>
    <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} size={13} />
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

  <div bind:this={scrollContainer} class="min-h-0 flex-1 overflow-auto p-2">
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
        {#if mode === 'diffs'}
          <div class="space-y-2">
            {#if checkpoint.failure}
              <p
                class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
              >
                {checkpoint.failure}
              </p>
            {/if}
            {#if loadingDiffs && fileDiffs.length === 0}
              <div class="flex items-center justify-center gap-2 py-8 text-xs text-dimmed">
                <Loader2 size={14} class="animate-spin" />
                Loading diffs
              </div>
            {:else if fileDiffs.length === 0}
              <p class="px-3 py-4 text-center text-[10px] text-dimmed">
                {checkpoint.changes.length === 0
                  ? 'No file changes detected.'
                  : 'No file diffs are available.'}
              </p>
            {:else}
              {#each fileDiffs as fileDiff (fileDiff.path)}
                {@const details = fileDiff.binary
                  ? null
                  : diffDetails(fileDiff.before, fileDiff.after)}
                {@const stats = details}
                {@const expanded = expandedDiffs[fileDiff.path] ?? true}
                <section
                  data-reveal-path={fileDiff.path}
                  class={[
                    'overflow-hidden rounded-md border transition-colors',
                    flashPath === fileDiff.path
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface'
                  ]}
                >
                  <div class="flex min-h-9 items-center pr-1.5">
                    <button
                      type="button"
                      class="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-elevated"
                      aria-expanded={expanded}
                      title={expanded
                        ? `Collapse diff for ${fileDiff.path}`
                        : `Show diff for ${fileDiff.path}`}
                      onclick={() => toggleDiff(fileDiff.path)}
                    >
                      <FileTypeIcon path={fileDiff.path} size={13} />
                      <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
                        {fileDiff.path}
                      </span>
                      {#if fileDiff.binary}
                        <span class="shrink-0 text-[9px] text-dimmed">binary</span>
                      {:else if stats}
                        <span class="shrink-0 font-mono text-[10px] tabular-nums text-success">
                          +{stats.additions}
                        </span>
                        <span class="shrink-0 font-mono text-[10px] tabular-nums text-danger">
                          −{stats.deletions}
                        </span>
                      {/if}
                      {#if expanded}
                        <ChevronDown size={12} class="shrink-0 text-dimmed" />
                      {:else}
                        <ChevronRight size={12} class="shrink-0 text-dimmed" />
                      {/if}
                    </button>
                    <button
                      type="button"
                      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                      aria-label={`Open ${fileDiff.path} in the changes sidebar`}
                      title={`Open ${fileDiff.path} in the changes sidebar`}
                      onclick={() => void openChange(checkpoint.id, fileDiff.path)}
                    >
                      <Eye size={13} />
                    </button>
                  </div>
                  {#if expanded}
                    <div class="border-t border-border">
                      <FileDiffView diff={fileDiff} maxHeight="24rem" />
                    </div>
                  {/if}
                </section>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="space-y-2">
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
                    <div
                      class="flex h-8 items-center gap-2 px-3 transition-colors hover:bg-elevated"
                    >
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
    {/if}
  </div>
</div>
