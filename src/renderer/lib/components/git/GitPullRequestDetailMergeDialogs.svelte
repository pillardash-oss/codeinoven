<script lang="ts">
  import type { PullRequestSummary } from '$shared/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  /**
   * The reader's close, conflict-resolution and branch-deletion confirmations.
   *
   * The merge confirmation is deliberately not here. It holds parameters worth
   * reviewing before they run (the method, the commit title, the message a squash
   * commit will carry) and the list's row menu asks the same question, so it lives
   * in `PrMergeConfirmDialog.svelte` and both surfaces mount that one.
   */
  interface Props {
    number: number
    summary: PullRequestSummary
    closeOpen: boolean
    resolveOpen: boolean
    deleteBranchOpen: boolean
    onResolveLocally: () => void
    onClosePullRequest: () => void
    onDeleteBranch: () => void
  }

  let {
    number,
    summary,
    closeOpen = $bindable(),
    resolveOpen = $bindable(),
    deleteBranchOpen = $bindable(),
    onResolveLocally,
    onClosePullRequest,
    onDeleteBranch
  }: Props = $props()
</script>

<ConfirmDialog
  open={resolveOpen}
  title={`Resolve conflicts for PR #${number}?`}
  onCancel={() => (resolveOpen = false)}
  onConfirm={() => {
    resolveOpen = false
    onResolveLocally()
  }}
  confirmLabel="Resolve locally"
  variant="primary"
>
  <p>
    This checks out the <strong class="text-foreground">{summary.headRef}</strong> branch locally as
    <code class="font-mono">pr-{number}</code>, merges
    <strong class="text-foreground">{summary.baseRef}</strong> into it, and switches the Git panel to
    the changes tab. You'll resolve each conflicted file in your editor, then commit and push to update
    the pull request.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={closeOpen}
  title={`Close pull request #${number}?`}
  onCancel={() => (closeOpen = false)}
  onConfirm={onClosePullRequest}
  confirmLabel="Close"
>
  <p>
    <strong class="text-foreground">{summary.title}</strong> will be closed without merging. You can reopen
    it later from this view.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={deleteBranchOpen}
  title={`Delete branch “${summary.headRef}”?`}
  onCancel={() => (deleteBranchOpen = false)}
  onConfirm={onDeleteBranch}
  confirmLabel="Delete branch"
>
  <p>
    Branch <strong class="text-foreground">{summary.headRef}</strong> will be deleted from the
    repository. The merge is already in {summary.baseRef}, so nothing merged is lost, but anyone
    still working on this branch loses the one it tracks.
  </p>
</ConfirmDialog>
