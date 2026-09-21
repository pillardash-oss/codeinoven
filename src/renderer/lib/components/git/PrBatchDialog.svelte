<script lang="ts">
  import { AlertTriangle } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import type { PrBatchResult } from '$lib/stores/git-store-pr-operations.svelte'
  import type { PullRequestSummary } from '$shared/types'

  /**
   * One confirmation and one result for a lifecycle batch.
   *
   * The confirmation names the count and the numbers, because closing twenty pull
   * requests from a list is one keystroke away from closing twenty-one and there is
   * no undo. The result names the failures individually, because `gitState.error`
   * holds a single message and a batch that closed seventeen of twenty has to say
   * which three are still open and why.
   */
  interface Props {
    /**
     * The batch this dialog owns. It is mounted only while one is pending, so the
     * reported result cannot outlive the batch that produced it and reappear over
     * the next confirmation.
     */
    batch: { mode: 'close' | 'reopen'; targets: PullRequestSummary[] }
    projectId: string
    owner: string
    repo: string
    onClose: () => void
  }

  let { batch, projectId, owner, repo, onClose }: Props = $props()

  let result = $state<PrBatchResult | null>(null)

  const busy = $derived(gitState.isBusy('pr-close') || gitState.isBusy('pr-reopen'))
  const targets = $derived(batch.targets)
  const mode = $derived(batch.mode)

  const verb = $derived(mode === 'close' ? 'Close' : 'Reopen')
  const pastVerb = $derived(mode === 'close' ? 'closed' : 'reopened')
  const title = $derived(
    targets.length === 1
      ? `${verb} pull request #${targets[0]?.number}?`
      : `${verb} ${targets.length} pull requests?`
  )

  /** Numbers named in full up to a bound, then counted: a dialog is not a log. */
  const LIST_LIMIT = 12
  const namedNumbers = $derived(targets.slice(0, LIST_LIMIT))
  const unlistedNumbers = $derived(targets.length - namedNumbers.length)

  function describe(target: PullRequestSummary): string {
    return `#${target.number}`
  }

  async function run(): Promise<void> {
    const numbers = targets.map((target) => target.number)
    const outcome =
      mode === 'close'
        ? await gitState.closePullRequests(projectId, owner, repo, numbers)
        : await gitState.reopenPullRequests(projectId, owner, repo, numbers)
    result = outcome
  }

  /** Dismissal is refused while the batch runs: the answer would be lost with it. */
  function cancel(): void {
    if (busy) return
    onClose()
  }
</script>

<ConfirmDialog
  open={result === null}
  {title}
  confirmLabel={verb}
  {busy}
  onCancel={cancel}
  onConfirm={() => void run()}
>
  <p>
    {#if targets.length === 1}
      <strong class="text-foreground">{targets[0]?.title}</strong>
      {mode === 'close'
        ? ' will be closed without merging. You can reopen it from this list.'
        : ' will be reopened.'}
    {:else}
      {targets.length} pull requests will be {pastVerb}
      {mode === 'close' ? ' without merging' : ''}. You can change their state again from this list.
    {/if}
  </p>
  <p class="font-mono text-[0.6875rem] leading-relaxed text-dimmed">
    {namedNumbers.map(describe).join(', ')}{unlistedNumbers > 0
      ? ` and ${unlistedNumbers} more`
      : ''}
  </p>
</ConfirmDialog>

<Modal
  open={result !== null}
  title={result ? `${result.succeeded.length} of ${targets.length} ${pastVerb}` : ''}
  {onClose}
>
  {#if result}
    <div class="space-y-3 text-sm text-muted">
      <p>
        {#if result.succeeded.length > 0}
          <strong class="text-foreground">{result.succeeded.length}</strong>
          {result.succeeded.length === 1 ? 'pull request' : 'pull requests'}
          {pastVerb}.
        {:else}
          Nothing was {pastVerb}.
        {/if}
      </p>

      {#if result.failed.length > 0}
        <div class="space-y-1.5">
          <p class="flex items-center gap-1.5 font-medium text-danger">
            <AlertTriangle size={13} class="shrink-0" />
            {result.failed.length}
            {result.failed.length === 1 ? 'pull request' : 'pull requests'} could not be {pastVerb}
          </p>
          <ul class="space-y-1">
            {#each result.failed as failure (failure.number)}
              <li class="text-[0.6875rem] leading-relaxed">
                <span class="font-mono text-foreground">#{failure.number}</span>
                <span class="text-dimmed"> · {failure.message}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if result.skipped.length > 0}
        <p class="text-[0.6875rem] leading-relaxed text-dimmed">
          {result.skipped.length} were not attempted because the batch stopped:
          {result.stoppedBy ?? 'the provider refused the request'}
        </p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover"
      onclick={onClose}
    >
      Done
    </button>
  {/snippet}
</Modal>
