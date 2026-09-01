<script lang="ts">
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
  let busy = $state(false)
  let error = $state<string | null>(null)
  let conflicted = $state(false)

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

  function close(): void {
    preflight = null
    error = null
    busy = false
    conflicted = false
    onClose()
  }

  async function loadPreflight(): Promise<void> {
    busy = true
    error = null
    try {
      preflight = await scopeState.mergeToScopePreflight(
        projectId,
        sourceBucketId,
        mergeTargetBucketId,
        mode
      )
      conflicted = false
    } catch (cause) {
      preflight = null
      error = cause instanceof Error ? cause.message : 'The merge preflight could not be run.'
    } finally {
      busy = false
    }
  }

  async function confirm(): Promise<void> {
    if (!preflight) return
    busy = true
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
      busy = false
    }
  }

  function selectMode(value: ScopeMergeMode): void {
    if (mode === value) return
    mode = value
    void loadPreflight()
  }

  $effect(() => {
    if (open) {
      mode = 'merge-delete'
      mergeTargetBucketId = DEFAULT_SCOPE_BUCKET_ID
      preflight = null
      error = null
      busy = false
      conflicted = false
      void loadPreflight()
    }
  })
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

    {#if !preflight && !error}
      <p class="text-sm text-muted">Checking this scope before anything is changed…</p>
    {/if}

    {#if preflight}
      <div class="space-y-2 rounded-lg border bg-elevated/50 p-3 text-xs text-muted">
        <p class="flex items-center justify-between">
          <span>Merge branch</span>
          <span class="font-medium text-foreground tabular-nums">{preflight.sourceBranch}</span>
        </p>
        <p class="flex items-center justify-between">
          <span>Into (target branch)</span>
          <span class="font-medium text-foreground tabular-nums">{preflight.targetBranch}</span>
        </p>
        {#if mode === 'merge-delete'}
          <p class="flex items-center justify-between">
            <span>Threads to delete</span>
            <span class="font-medium text-foreground tabular-nums">{preflight.threadCount}</span>
          </p>
        {:else if mode === 'merge-move-to-default'}
          <p class="flex items-center justify-between">
            <span>Threads to move to Default</span>
            <span class="font-medium text-foreground tabular-nums">{preflight.threadCount}</span>
          </p>
        {/if}
        {#if mode === 'merge-delete' || mode === 'merge-move-to-default'}
          <p class="flex items-center justify-between">
            <span>Unpushed commits</span>
            <span class="font-medium text-foreground tabular-nums">
              {preflight.unpushedCommits}
            </span>
          </p>
        {/if}
      </div>

      {#if preflight.hasActiveProcesses}
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          Active agent processes are still running in this scope.
        </div>
      {/if}
      {#if (preflight.dirtyFiles.length ?? 0) > 0 && (mode === 'merge-delete' || mode === 'merge-move-to-default')}
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <p class="font-medium">
            Uncommitted changes will be lost ({preflight.dirtyFiles.length})
          </p>
          <ul class="mt-1 max-h-24 list-inside list-disc overflow-y-auto">
            {#each preflight.dirtyFiles.slice(0, 20) as file (file)}
              <li class="truncate">{file}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if mode === 'merge-delete' || mode === 'merge-move-to-default'}
        <p class="text-xs text-muted">
          Default scope worktree and {preflight.sourceBranch} branch are removed when the merge completes.
        </p>
      {/if}
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
    disabled={!preflight || busy}
    onclick={() => void confirm()}
  >
    {busy ? 'Working…' : mode === 'merge-keep' ? 'Merge' : 'Merge & close'}
  </button>
{/snippet}
