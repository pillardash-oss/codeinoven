<script lang="ts">
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import GitIssueDetail from './GitIssueDetail.svelte'
  import MetadataPickerDialog from './MetadataPickerDialog.svelte'
  import { issueRelationshipSummary, type IssueReaderAction } from './issue-view'
  import { composePullRequestForIssue, setIssueState, workOnIssue } from './git-issue-actions'
  import type { IssueRelationshipItem, IssueSummary } from '$shared/types'
  import type { PrMetadataMode } from './pr-view'

  /**
   * One issue, read and acted on.
   *
   * The reader and everything an issue can be made to do: the label, assignee and
   * milestone pickers, closing with GitHub's own reason, handing it to an agent,
   * and composing the pull request that closes it. It is its own component because
   * two surfaces read an issue and only one of them has a list   the Issues tab,
   * which opens a row here, and the Notifications view, which opens the issue a
   * notification names, in the repository that notification came from.
   */
  interface Props {
    projectId: string
    /** The thread a pull request opened from here is filed under. */
    threadId: string
    /** The checkout the "Create pull request" action opens the PR sheet in. */
    scopeBucketId: string
    /** Repository the issue belongs to, which need not be the open project's. */
    identity: { owner: string; repo: string }
    issue: IssueSummary
    /**
     * Return to whatever opened this reader. The Issues tab returns to its list;
     * the Git panel owns the control itself and passes none, because its action
     * row names the view being returned to.
     */
    onBack?: () => void
    /**
     * Whether the issue lives in the project's own repository.
     *
     * "Create pull request" composes a pull request in that project, so it is
     * offered only when the issue is one of its own: prefilling the sheet from an
     * issue number that belongs to another repository would attach the request to
     * a stranger's issue. Defaults to true, which is the Issues tab's case.
     */
    localRepository?: boolean
    /**
     * A dialog a list row asked for, raised as soon as the reader opens. Pass it
     * with `onActionHandled`, which clears the caller's copy: a request left set
     * is a dialog that cannot be dismissed.
     */
    action?: IssueReaderAction | null
    /** Reports that `action` has settled, so the caller can clear it. */
    onActionHandled?: () => void
    /** Open a commit this issue's history references, in the Git panel. */
    onOpenCommit: (commitId: string) => void
  }

  let {
    projectId,
    threadId,
    scopeBucketId,
    identity,
    issue,
    onBack,
    localRepository = true,
    action = null,
    onActionHandled,
    onOpenCommit
  }: Props = $props()

  /**
   * The issue this reader is showing.
   *
   * A related issue opened from here replaces the one being read without the host
   * being told, and the override is held against the issue's number so a host that
   * hands over a different issue (another notification, another list row) is read
   * as itself rather than as the last related link followed.
   */
  let related = $state<IssueSummary | null>(null)
  const subject = $derived(related && related.number !== issue.number ? related : issue)

  /** A request a row made, until it has been raised and settled. */
  let consumedAction = $state<IssueReaderAction | null>(null)
  const requested = $derived(action !== null && action !== consumedAction ? action : null)

  /** The reader's own copy of the two dialogs it raises from its own controls. */
  let ownMetadata = $state<{ mode: PrMetadataMode; issue: IssueSummary } | null>(null)
  let ownCloseTarget = $state<IssueSummary | null>(null)

  /**
   * The dialog showing, from either door.
   *
   * Derived rather than assigned in an effect: a request from a row opens the
   * dialog it names, and the reader's own controls open theirs, and neither has to
   * be watched to work.
   */
  const metadata = $derived(
    requested?.kind === 'metadata' ? { mode: requested.mode, issue: subject } : ownMetadata
  )
  const confirmingClose = $derived(requested?.kind === 'close' ? subject : ownCloseTarget)

  const metadataBusy = $derived(gitState.isBusy('issue-metadata'))
  const stateBusy = $derived(gitState.isBusy('issue-state'))

  /** The issue the metadata picker draws, resolved from the cached bundle. */
  const metadataSubject = $derived(
    metadata
      ? (gitState.issueBundles[
          GitState.issueBundleKey(identity.owner, identity.repo, metadata.issue.number)
        ]?.detail ?? metadata.issue)
      : null
  )

  /** Settle whichever door raised the close confirmation. */
  function dismissClose(): void {
    if (requested?.kind === 'close') {
      consumedAction = requested
      onActionHandled?.()
    }
    ownCloseTarget = null
  }

  /** Settle whichever door raised the metadata picker. */
  function dismissMetadata(): void {
    if (requested?.kind === 'metadata') {
      consumedAction = requested
      onActionHandled?.()
    }
    ownMetadata = null
  }

  /**
   * Settle the issue on GitHub.
   *
   * The reader follows the subject it opened on, so a state change updates the
   * open issue's header rather than leaving it claiming the old state.
   */
  async function applyState(
    target: IssueSummary,
    state: 'open' | 'closed',
    stateReason?: 'completed' | 'not_planned'
  ): Promise<void> {
    if (!(await setIssueState(projectId, identity, target, state, stateReason))) return
    if (subject.number === target.number) {
      related = { ...subject, state, stateReason: stateReason ?? null }
    }
  }
</script>

<div class="h-full min-h-0">
  <GitIssueDetail
    {projectId}
    {identity}
    issue={subject}
    {onBack}
    onWorkOn={(target) => void workOnIssue(projectId, identity, target)}
    onCreatePr={localRepository
      ? (target) => composePullRequestForIssue(projectId, threadId, scopeBucketId, target)
      : undefined}
    onEditMetadata={(mode, target) => (ownMetadata = { mode, issue: target })}
    onRequestClose={(target) => (ownCloseTarget = target)}
    onReopen={(target) => void applyState(target, 'open')}
    onOpenRelated={(item: IssueRelationshipItem) => (related = issueRelationshipSummary(item))}
    {onOpenCommit}
    onOpenInBrowser={(target) => void openInBrowser(target.url)}
  />
</div>

{#if metadata && metadataSubject}
  <MetadataPickerDialog
    number={metadataSubject.number}
    mode={metadata.mode}
    {projectId}
    owner={identity.owner}
    repo={identity.repo}
    current={{
      labels: metadataSubject.labels,
      assignees: metadataSubject.assignees,
      milestone: metadataSubject.milestone
    }}
    authorLogin={metadataSubject.authorLogin}
    busy={metadataBusy}
    onClose={dismissMetadata}
    onSave={async (selection) => {
      if (metadata?.mode === 'labels') {
        return gitState.setIssueLabels(
          projectId,
          identity.owner,
          identity.repo,
          metadataSubject.number,
          selection.labels
        )
      }
      if (metadata?.mode === 'assignees') {
        return gitState.setIssueAssignees(
          projectId,
          identity.owner,
          identity.repo,
          metadataSubject.number,
          selection.assignees
        )
      }
      return gitState.setIssueMilestone(
        projectId,
        identity.owner,
        identity.repo,
        metadataSubject.number,
        selection.milestone
      )
    }}
  />
{/if}

<ConfirmDialog
  open={confirmingClose !== null}
  title="Close issue #{confirmingClose?.number ?? ''}?"
  confirmLabel="Close as completed"
  size="lg"
  variant="primary"
  busy={stateBusy}
  secondaryAction={{
    label: 'Close as not planned',
    onSelect: () => {
      const target = confirmingClose
      dismissClose()
      if (target) void applyState(target, 'closed', 'not_planned')
    }
  }}
  onCancel={dismissClose}
  onConfirm={() => {
    const target = confirmingClose
    dismissClose()
    if (target) void applyState(target, 'closed', 'completed')
  }}
>
  <p class="text-xs leading-relaxed text-muted">
    The issue is closed on GitHub. It stays readable and can be reopened.
  </p>
  <p class="mt-2 text-[0.6875rem] leading-relaxed text-dimmed">
    <strong class="text-foreground">Completed</strong> records it as done, closed, fixed or
    resolved.
    <strong class="text-foreground">Not planned</strong> records it as won't fix, cannot reproduce, or
    stale.
  </p>
</ConfirmDialog>
