<script lang="ts">
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioWrench from '@pdslng/cio-icon/CioWrench.svelte'
  import { onMount } from 'svelte'

  import { toast } from 'svelte-sonner'
  import { scopeState } from '$lib/stores/scope.svelte'
  import {
    isScopeWorktreeHealthRepairable,
    REPAIR_HINT,
    scopeWorktreeHealthGuidance
  } from '$shared/scope-worktree-health'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import ErrorStrip, { type ErrorStripAction } from '../ui/ErrorStrip.svelte'
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

  let repairAction = $derived<ErrorStripAction | undefined>(
    repairable
      ? {
          label: busyAction === 'repair' ? 'Repairing…' : 'Repair worktree',
          title: `Repair the managed worktree of ${name ?? 'this scope'}`,
          icon: CioWrench,
          disabled: busyAction !== null,
          onclick: () => void repair()
        }
      : undefined
  )
  let setupAction = $derived<ErrorStripAction | undefined>(
    setupStale
      ? {
          label: busyAction === 'setup' ? 'Running setup…' : 'Re-run setup',
          title: `Re-run the setup commands in the worktree of ${name ?? 'this scope'}`,
          icon: CioRefresh,
          disabled: busyAction !== null,
          onclick: () => void rerunSetup()
        }
      : undefined
  )

  /**
   * One key for both variants: this is one condition about one scope, so closing
   * it in the panel closes it on the scope card too. The signature is the
   * category plus the path it expected, so a worktree that recovers and breaks
   * again, or breaks in a different way, raises its own notice instead of
   * staying silent under the dismissal.
   */
  const noticeId = $derived(`scope.health:${targetProjectId ?? ''}:${scopeBucketId}`)
  const noticeCondition = $derived(
    visible ? `${health?.category ?? 'setup'}|${expectedPath ?? ''}|${setupStale}` : ''
  )

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

{#if visible && !noticeDismissals.isDismissed(noticeId, noticeCondition)}
  <!--
    One strip for both variants: the card's compact row starts folded, the panel
    banner starts open. The fix is the strip's one primary action, so it is in
    the header while folded and in the footer once open; a stale setup beside a
    repair is the footer's other button.
  -->
  <ErrorStrip
    {title}
    icon={CioAttention}
    message={repairable ? fix.replace(REPAIR_HINT, '').trim() : fix}
    tone="warning"
    folded={variant === 'inline'}
    primary={repairAction ?? setupAction}
    onDismiss={() => noticeDismissals.dismiss(noticeId, noticeCondition)}
  >
    {#if expectedPath}
      <p class="truncate font-mono text-xs text-muted" title={expectedPath}>{expectedPath}</p>
    {/if}
    {#if actionError}
      <p class="text-xs text-danger">{actionError}</p>
    {/if}
    {#snippet footerEnd()}
      {#if repairAction && setupAction}
        <CardButton
          label={setupAction.label}
          title={setupAction.title}
          icon={setupAction.icon}
          variant="secondary"
          disabled={setupAction.disabled}
          onclick={setupAction.onclick}
        />
      {/if}
    {/snippet}
  </ErrorStrip>
{/if}
