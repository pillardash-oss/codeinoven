<script lang="ts">
  import { onMount } from 'svelte'
  import { TriangleAlert, Wrench, RefreshCw } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { scopeState } from '$lib/stores/scope.svelte'
  import {
    isScopeWorktreeHealthRepairable,
    scopeWorktreeHealthGuidance
  } from '$shared/scope-worktree-health'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import type { ScopeWorktreeHealth } from '$shared/types'

  interface Props {
    /** Project that owns the scope; defaults to the active project. */
    projectId?: string
    scopeBucketId: string
    /** Scope display name, used in the copy and in every button title. */
    name?: string
    /** `panel` is a full-width banner; `inline` is one compact row for a scope card. */
    variant?: 'panel' | 'inline'
    /** Called after a successful repair so the owner can refresh its own view. */
    onRepaired?: (health: ScopeWorktreeHealth) => void
  }

  let { projectId, scopeBucketId, name, variant = 'panel', onRepaired }: Props = $props()

  let busyAction = $state<'repair' | 'setup' | null>(null)
  let actionError = $state<string | null>(null)

  let targetProjectId = $derived(projectId ?? scopeState.activeProjectId)
  let health = $derived(
    targetProjectId ? scopeState.healthFor(scopeBucketId, targetProjectId) : undefined
  )
  let unhealthy = $derived(health !== undefined && health.category !== 'healthy')
  let bucket = $derived(
    targetProjectId ? scopeState.bucketFor(targetProjectId, scopeBucketId) : null
  )
  /**
   * A `stale` setup state means the checkout was re-created after its setup had
   * already run, so the recorded results no longer describe the working tree.
   */
  let setupStale = $derived(bucket?.root.kind === 'worktree' && bucket.root.setup.state === 'stale')
  let visible = $derived(unhealthy || setupStale)

  let guidance = $derived(health ? scopeWorktreeHealthGuidance(health) : null)
  let repairable = $derived(unhealthy && isScopeWorktreeHealthRepairable(health))
  let expectedPath = $derived(unhealthy ? health?.expectedPath : undefined)

  let scopeLabel = $derived(name ? `"${name}"` : 'this scope')

  let title = $derived(
    unhealthy && guidance ? guidance.cause : 'Setup has to run again in this worktree'
  )
  let fix = $derived(
    unhealthy && guidance
      ? guidance.fix
      : 'Repairing this worktree restored the committed files only, so its dependencies and build output are gone. Run the setup commands again to rebuild them.'
  )

  // Passive but live: whenever this notice appears (the user switched to, or
  // acted in, a scope) re-read the checkout's real state before advising.
  onMount(() => {
    const id = targetProjectId
    if (!id) return
    void scopeState.revalidateWorktreeHealth(id, scopeBucketId).catch(() => undefined)
  })

  async function repair(): Promise<void> {
    const id = targetProjectId
    if (!id || busyAction) return
    busyAction = 'repair'
    actionError = null
    try {
      const result = await scopeState.repairWorktree({ projectId: id, scopeBucketId })
      onRepaired?.(result)
      if (result.category === 'healthy') {
        const repaired = scopeState.bucketFor(id, scopeBucketId)
        const needsSetup =
          repaired?.root.kind === 'worktree' && repaired.root.setup.state === 'stale'
        toast.success(`The worktree for ${scopeLabel} was restored`, {
          description: needsSetup
            ? 'Run the setup commands again to rebuild dependencies and build output.'
            : undefined,
          closeButton: true
        })
      } else {
        actionError = scopeWorktreeHealthGuidance(result).cause
      }
    } catch (cause) {
      actionError = ipcErrorMessage(cause, 'The worktree could not be repaired.')
    } finally {
      busyAction = null
    }
  }

  async function rerunSetup(): Promise<void> {
    const id = targetProjectId
    if (!id || busyAction) return
    busyAction = 'setup'
    actionError = null
    try {
      await scopeState.retryWorktreeSetup(id, scopeBucketId, true)
      toast.success(`Setup finished in ${scopeLabel}`, { closeButton: true })
    } catch (cause) {
      actionError = ipcErrorMessage(cause, 'Setup could not be re-run.')
    } finally {
      busyAction = null
    }
  }
</script>

{#snippet actions()}
  <div class="flex flex-wrap items-center gap-2">
    {#if repairable}
      <button
        type="button"
        class="rounded-md bg-primary px-2 py-1 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        title="Repair the managed worktree of {name ?? 'this scope'}"
        aria-label="Repair the managed worktree of {name ?? 'this scope'}"
        disabled={busyAction !== null}
        onclick={() => void repair()}
      >
        <span class="flex items-center gap-1.5">
          <Wrench size={11} />
          {busyAction === 'repair' ? 'Repairing…' : 'Repair worktree'}
        </span>
      </button>
    {/if}
    {#if setupStale}
      <button
        type="button"
        class="rounded-md border border-overlay px-2 py-1 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:opacity-50"
        title="Re-run the setup commands in the worktree of {name ?? 'this scope'}"
        aria-label="Re-run the setup commands in the worktree of {name ?? 'this scope'}"
        disabled={busyAction !== null}
        onclick={() => void rerunSetup()}
      >
        <span class="flex items-center gap-1.5">
          <RefreshCw size={11} />
          {busyAction === 'setup' ? 'Running setup…' : 'Re-run setup'}
        </span>
      </button>
    {/if}
  </div>
{/snippet}

{#if visible}
  {#if variant === 'inline'}
    <div
      class="flex min-w-0 items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2 py-1.5"
      role="status"
    >
      <TriangleAlert size={12} class="shrink-0 text-warning" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-[0.6875rem] text-warning" title="{title}. {fix}">{title}</p>
        {#if actionError}
          <p class="truncate text-[0.625rem] text-danger" title={actionError}>{actionError}</p>
        {/if}
      </div>
      {@render actions()}
    </div>
  {:else}
    <div
      class="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5"
      role="status"
    >
      <TriangleAlert size={14} class="mt-0.5 shrink-0 text-warning" />
      <div class="min-w-0 flex-1 space-y-1.5">
        <p class="text-xs font-medium text-warning">{title}</p>
        <p class="text-[0.6875rem] text-muted">{fix}</p>
        {#if expectedPath}
          <p class="truncate font-mono text-[0.625rem] text-dimmed" title={expectedPath}>
            {expectedPath}
          </p>
        {/if}
        {#if actionError}
          <p class="text-[0.6875rem] text-danger">{actionError}</p>
        {/if}
        {@render actions()}
      </div>
    </div>
  {/if}
{/if}
