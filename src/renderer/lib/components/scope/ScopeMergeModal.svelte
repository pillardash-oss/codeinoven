<script lang="ts">
  import { RefreshCw } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import {
    DEFAULT_SCOPE_BUCKET_ID,
    type ScopeMergeMode,
    type ScopeMergePreflight,
    type ScopeMergeOutcome
  } from '$shared/types'

  interface Props {
    open: boolean
    projectId: string
    /** The managed-worktree scope being merged (source). */
    sourceBucketId: string
    onClose: () => void
    onDone?: () => void
    /** Called when the merge lands in conflict so the UI can open the Git panel. */
    onConflicts?: (sourceProjectId: string, targetScopeBucketId: string) => void
  }

  let { open, projectId, sourceBucketId, onClose, onDone, onConflicts }: Props = $props()

  let mode = $state<ScopeMergeMode>('merge-delete')
  let mergeTargetBucketId = $state(DEFAULT_SCOPE_BUCKET_ID)
  let preflight = $state<ScopeMergePreflight | null>(null)
  let working = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let conflicted = $state(false)

  /** True when `preflight` matches the currently selected mode and target. */
  const preflightMatches = $derived(
    preflight !== null &&
      preflight.mode === mode &&
      preflight.mergeTargetScopeBucketId === mergeTargetBucketId
  )

  function close(): void {
    preflight = null
    error = null
    working = false
    refreshing = false
    conflicted = false
    onClose()
  }

  let preflightSeq = 0
  /**
   * Quietly refresh the consequence summary. The previous summary stays visible,
   * the footer never changes, and a stale in-flight request can never overwrite
   * a newer one. Errors keep the last good summary so the dialog never blanks.
   */
  async function loadPreflight(): Promise<void> {
    const seq = ++preflightSeq
    refreshing = true
    error = null
    try {
      const next = await scopeState.mergeToScopePreflight(
        projectId,
        sourceBucketId,
        mergeTargetBucketId,
        mode
      )
      if (seq !== preflightSeq) return
      preflight = next
      conflicted = false
    } catch (cause) {
      if (seq !== preflightSeq) return
      error = cause instanceof Error ? cause.message : 'The merge preflight could not be run.'
      // Keep the last resolved preflight so the dialog never disappears on a
      // transient refresh failure.
    } finally {
      if (seq === preflightSeq) refreshing = false
    }
  }

  async function confirm(): Promise<void> {
    if (!preflightMatches || !preflight) return
    working = true
    error = null
    try {
      const outcome: ScopeMergeOutcome = await scopeState.confirmScopeMerge(
        projectId,
        sourceBucketId,
        mergeTargetBucketId,
        mode,
        preflight.confirmationId
      )
      if (!outcome.merged && outcome.conflicted.length > 0) {
        conflicted = true
        onConflicts?.(projectId, mergeTargetBucketId)
        onDone?.()
        close()
        return
      }
      await scopeState.loadBoard(projectId)
      onDone?.()
      close()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The merge could not be completed.'
    } finally {
      working = false
    }
  }

  function selectMode(value: ScopeMergeMode): void {
    if (mode === value) return
    mode = value
    void loadPreflight()
  }

  // Reset and fetch only on the false→true open transition. This effect must
  // never re-run when `mode` or `mergeTargetBucketId` change: `loadPreflight`
  // reads them synchronously, which would otherwise make the effect re-fire on
  // every mode/target click and snap the selection back to the default.
  let wasOpen = false
  $effect(() => {
    if (open === wasOpen) return
    wasOpen = open
    if (!open) return
    mode = 'merge-delete'
    mergeTargetBucketId = DEFAULT_SCOPE_BUCKET_ID
    preflight = null
    error = null
    working = false
    refreshing = false
    conflicted = false
    void loadPreflight()
  })
  const sourceBucket = $derived(
    scopeState.board.buckets.find((bucket) => bucket.id === sourceBucketId) ?? null
  )

  /** Scopes the source branch may be merged into — every scope but the source. */
  const targetOptions = $derived(
    scopeState.board.buckets.filter((bucket) => bucket.id !== sourceBucketId)
  )

  interface ModeOption {
    value: ScopeMergeMode
    label: string
    description: string
    destructive: boolean
  }

  const modeOptions: ModeOption[] = [
    {
      value: 'merge-delete',
      label: 'Merge & delete scope',
      description:
        'Merge into the target, then delete this scope. Deletes its threads, the worktree, and the cio/ branch.',
      destructive: true
    },
    {
      value: 'merge-keep',
      label: 'Merge & keep scope',
      description:
        'Merge into the target and keep this scope. Use to update the default scope while work continues on the worktree.',
      destructive: false
    },
    {
      value: 'merge-move-to-default',
      label: 'Merge, delete & move threads',
      description:
        'Merge into the target, then delete this scope but move its threads into Default, evicting the oldest Default threads to respect the thread limit.',
      destructive: true
    }
  ]

  function targetLabel(bucketId: string): string {
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) return 'Default scope (project root)'
    const bucket = scopeState.board.buckets.find((b) => b.id === bucketId)
    if (!bucket) return bucketId
    return bucket.root.kind === 'worktree' ? `${bucket.name} (worktree)` : bucket.name
  }

  /** Fixed summary rows — the row always exists; only its label text changes. */
  const threadRowLabel = $derived(
    mode === 'merge-delete'
      ? 'Threads to delete'
      : mode === 'merge-move-to-default'
        ? 'Threads to move to Default'
        : 'Threads kept in scope'
  )

  /** Always-rendered bottom note; text adapts to the selected mode. */
  const modeNote = $derived(
    mode === 'merge-keep'
      ? 'The worktree, this scope and its threads are kept — nothing is removed.'
      : mode === 'merge-move-to-default'
        ? 'The worktree is removed, this scope is deleted, and its threads move to Default (evicting the oldest Default threads to respect the thread limit).'
        : 'The worktree and the branch are removed, and this scope is deleted, after the merge completes.'
  )
</script>

<Modal {open} title="Merge scope into project" onClose={close} footer={footerSnippet}>
  <div class="space-y-5">
    <p class="text-sm text-muted">
      Merge <span class="font-medium text-foreground">{sourceBucket?.name ?? 'this scope'}</span>
      back into the project. The merge target defaults to the Default scope.
    </p>

    <div>
      <p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Merge into</p>
      <select
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
        value={mergeTargetBucketId}
        onchange={(event: Event) => {
          mergeTargetBucketId = (event.currentTarget as HTMLSelectElement).value
          void loadPreflight()
        }}
        aria-label="Scope to merge into"
      >
        {#each targetOptions as target (target.id)}
          <option value={target.id}>{targetLabel(target.id)}</option>
        {/each}
      </select>
    </div>

    <div>
      <p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">After merging</p>
      <div class="space-y-2">
        {#each modeOptions as option (option.value)}
          <button
            type="button"
            class={[
              'flex w-full flex-col gap-1 rounded-xl border p-3 text-left transition-colors',
              mode === option.value
                ? 'border-primary bg-elevated ring-1 ring-primary/40'
                : 'border-border bg-surface hover:bg-elevated'
            ].join(' ')}
            onclick={() => selectMode(option.value)}
            aria-pressed={mode === option.value}
          >
            <span
              class="text-sm font-medium {option.destructive ? 'text-danger' : 'text-foreground'}"
            >
              {option.label}
            </span>
            <span class="text-xs text-muted">{option.description}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="relative space-y-2 rounded-lg border bg-elevated/50 p-3 text-xs text-muted">
      {#if refreshing}
        <RefreshCw
          size={12}
          class="absolute right-2 top-2 animate-spin text-dimmed"
          aria-hidden="true"
        />
      {/if}
      <p class="flex items-center justify-between pr-4">
        <span>Merge branch</span>
        <span class="font-medium text-foreground tabular-nums">
          {preflight?.sourceBranch ?? '\u2014'}
        </span>
      </p>
      <p class="flex items-center justify-between">
        <span>Into (target branch)</span>
        <span class="font-medium text-foreground tabular-nums">
          {preflight?.targetBranch ?? '\u2014'}
        </span>
      </p>
      <p class="flex items-center justify-between">
        <span>{threadRowLabel}</span>
        <span class="font-medium text-foreground tabular-nums">
          {preflight?.threadCount ?? '\u2014'}
        </span>
      </p>
      <p class="flex items-center justify-between">
        <span>Unpushed commits</span>
        <span class="font-medium text-foreground tabular-nums">
          {preflight?.unpushedCommits ?? '\u2014'}
        </span>
      </p>
    </div>

    <p class="text-xs text-muted">{modeNote}</p>

    {#if preflight?.hasActiveProcesses}
      <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
        Active agent processes are still running in this scope.
      </div>
    {/if}
    {#if (preflight?.dirtyFiles.length ?? 0) > 0}
      <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
        <p class="font-medium">
          {mode === 'merge-keep'
            ? `Uncommitted changes stay in the worktree (${preflight?.dirtyFiles.length ?? 0} files)`
            : `Uncommitted changes will be lost (${preflight?.dirtyFiles.length ?? 0} files)`}
        </p>
        <ul class="mt-1 max-h-24 list-inside list-disc overflow-y-auto">
          {#each (preflight?.dirtyFiles ?? []).slice(0, 20) as file (file)}
            <li class="truncate">{file}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if conflicted}
      <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
        The merge hit conflicts and nothing was deleted. Resolve them in the Git panel, then rerun
        this action once your work is committed.
      </div>
    {/if}

    {#if error}
      <p class="text-xs text-danger" role="alert">{error}</p>
    {/if}
  </div>
</Modal>

{#snippet footerSnippet()}
  <button
    type="button"
    class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
    onclick={close}
  >
    Cancel
  </button>
  <button
    type="button"
    class={[
      'rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50',
      mode === 'merge-keep'
        ? 'bg-primary text-on-primary hover:bg-primary-hover'
        : 'bg-danger text-on-danger hover:bg-danger-hover'
    ].join(' ')}
    disabled={!preflightMatches || working}
    onclick={() => void confirm()}
  >
    {working ? 'Merging…' : mode === 'merge-keep' ? 'Merge' : 'Merge & close'}
  </button>
{/snippet}
