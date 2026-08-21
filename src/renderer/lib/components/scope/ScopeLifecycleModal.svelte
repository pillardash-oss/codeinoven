<script lang="ts">
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { ScopeLifecycleAction, ScopeLifecyclePreflight } from '$shared/types'

  interface Props {
    open: boolean
    projectId: string
    bucketId: string
    action: ScopeLifecycleAction
    warnings?: string[]
    onClose: () => void
    onDone?: () => void
  }

  let { open, projectId, bucketId, action, warnings = [], onClose, onDone }: Props = $props()

  let preflight = $state<ScopeLifecyclePreflight | null>(null)
  let secondConfirm = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)

  let forceNeeded = $derived(
    action === 'remove-worktree' &&
      (preflight?.dirtyFiles.length ?? 0) > 0 &&
      (preflight?.unpushedCommits ?? 0) > 0
  )

  function labelFor(value: ScopeLifecycleAction): string {
    switch (value) {
      case 'detach':
        return 'Detach'
      case 'remove-worktree':
        return 'Remove Worktree'
      case 'delete-scope':
        return 'Delete Scope'
      case 'delete-branch':
        return 'Delete Branch'
      default:
        return 'Delete Project'
    }
  }

  function close(): void {
    preflight = null
    secondConfirm = false
    error = null
    busy = false
    onClose()
  }

  async function runPreflight(): Promise<void> {
    if (action === 'delete-scope') {
      preflight = {
        action,
        projectId,
        scopeBucketId: bucketId,
        dirtyFiles: [],
        unpushedCommits: 0,
        hasActiveProcesses: false,
        branchOwnedByWorktree: false,
        confirmationId: `delete-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        createdAt: Date.now()
      }
      return
    }
    preflight = await scopeState.preflightWorktree(projectId, bucketId, action)
  }

  async function confirm(): Promise<void> {
    if (!preflight) return
    busy = true
    error = null
    try {
      if (action === 'delete-scope') {
        await scopeState.removeBucket(bucketId)
        onDone?.()
        close()
        return
      }
      await scopeState.confirmWorktreeLifecycle(
        projectId,
        bucketId,
        action,
        preflight.confirmationId,
        { force: secondConfirm }
      )
      onDone?.()
      close()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The action could not be completed.'
    } finally {
      busy = false
    }
  }

  $effect(() => {
    if (open) {
      preflight = null
      secondConfirm = false
      error = null
      busy = false
      void runPreflight()
    }
  })
</script>

<Modal {open} title={`Confirm ${labelFor(action)}`} onClose={close} footer={footerSnippet}>
  <div class="space-y-4">
    {#if !preflight}
      <p class="text-sm text-muted">
        Checking this scope for blocking changes before anything is removed…
      </p>
    {:else}
      <div class="space-y-3">
        <p class="text-sm text-foreground">
          {action === 'detach'
            ? 'The worktree will be removed and this scope returns to the project directory.'
            : action === 'remove-worktree'
              ? 'The worktree will be removed from Git and this scope will be deleted.'
              : action === 'delete-scope'
                ? 'The scope will be removed from the board. Its worktree (if any) stays in place.'
                : action === 'delete-branch'
                  ? 'The scope branch will be deleted from the repository.'
                  : 'This project deletion will also remove its managed worktrees.'}
        </p>
        {#if (preflight.dirtyFiles.length ?? 0) > 0}
          <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <p class="font-medium">Dirty files ({preflight.dirtyFiles.length})</p>
            <ul class="mt-1 max-h-28 list-inside list-disc overflow-y-auto">
              {#each preflight.dirtyFiles.slice(0, 20) as file (file)}
                <li class="truncate">{file}</li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if (preflight.unpushedCommits ?? 0) > 0}
          <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            {preflight.unpushedCommits} unpushed commit(s) are not reachable from any remote.
          </div>
        {/if}
        {#if preflight.hasActiveProcesses}
          <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            Active agent processes are still running in this scope.
          </div>
        {/if}
        {#if forceNeeded}
          <div class="flex items-center justify-between gap-2 rounded-lg border bg-elevated p-3">
            <span class="text-xs text-muted">Force removal despite dirty/unpushed work</span>
            <Switch
              checked={secondConfirm}
              onchange={(value) => (secondConfirm = value)}
              label="Force"
            />
          </div>
        {/if}
        {#if action === 'delete-scope'}
          <p class="text-xs text-muted">
            Deleting the scope does not delete its branch. Use "Delete branch" afterwards if wanted.
          </p>
        {/if}
        {#if error}
          <p class="text-xs text-danger" role="alert">{error}</p>
        {/if}
        {#each warnings as warning (warning)}
          <p class="text-xs text-muted">{warning}</p>
        {/each}
      </div>
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
    class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-on-danger hover:bg-danger-hover disabled:opacity-50"
    disabled={!preflight || busy || (forceNeeded && !secondConfirm)}
    onclick={() => void confirm()}
  >
    {busy ? 'Working…' : 'Confirm'}
  </button>
{/snippet}
