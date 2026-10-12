<script lang="ts">
  import { gitState } from '$lib/stores/git.svelte'
  import type { PullRequestSummary } from '$shared/types'
  import MetadataPickerDialog from './MetadataPickerDialog.svelte'
  import type { PrMetadataMode } from './pr-view'

  /**
   * The label, assignee, and milestone pickers for one pull request.
   *
   * A thin adapter over `MetadataPickerDialog`: it supplies the pull request as the
   * subject and routes the save to the pull request writes, so the picker itself
   * stays free of which collection it is editing.
   */
  interface Props {
    pr: PullRequestSummary
    mode: PrMetadataMode
    projectId: string
    owner: string
    repo: string
    onClose: () => void
  }

  let { pr, mode, projectId, owner, repo, onClose }: Props = $props()

  const busy = $derived(gitState.isBusy('pr-metadata'))
</script>

<MetadataPickerDialog
  number={pr.number}
  {mode}
  {projectId}
  {owner}
  {repo}
  current={{ labels: pr.labels, assignees: pr.assignees, milestone: pr.milestone }}
  authorLogin={pr.authorLogin}
  {busy}
  {onClose}
  onSave={async (selection) => {
    if (mode === 'labels') {
      return gitState.setPullRequestLabels(projectId, owner, repo, pr.number, selection.labels)
    }
    if (mode === 'assignees') {
      return gitState.setPullRequestAssignees(
        projectId,
        owner,
        repo,
        pr.number,
        selection.assignees
      )
    }
    return gitState.setPullRequestMilestone(projectId, owner, repo, pr.number, selection.milestone)
  }}
/>
