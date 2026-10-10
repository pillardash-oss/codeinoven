<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { issuePanelView, type IssuePanelViewState } from '$lib/stores/issue-panel-view.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import GitIssueList from './GitIssueList.svelte'
  import GitIssueDetail from './GitIssueDetail.svelte'
  import MetadataPickerDialog from './MetadataPickerDialog.svelte'
  import { assignAgentToIssue } from './git-status-panel-agent-actions'
  import type { IssueListFilter, IssueListSort, IssueSummary, PrState } from '$shared/types'
  import type { PrMetadataMode } from './pr-view'

  interface Props {
    projectId: string
    /** The thread a pull request opened from here is filed under. */
    threadId: string
    /** The checkout the "Create pull request" action opens the PR sheet in. */
    scopeBucketId: string
    /** Repository the issues belong to; null when origin isn't a GitHub remote. */
    identity: { owner: string; repo: string } | null
    githubConnected: boolean
    onSignIn: () => void
  }

  let { projectId, threadId, scopeBucketId, identity, githubConnected, onSignIn }: Props = $props()

  /**
   * The tab's own view state, kept in its own store keyed by project.
   *
   * The panel unmounts this component whenever another tab is shown, so holding the
   * listing choice and the open issue here would lose them on every switch. The
   * store is project-scoped, which is also why a reopened panel lands on the issue
   * the user was reading.
   */
  const view = $derived(issuePanelView.get(projectId))

  function patch(next: Partial<IssuePanelViewState>): void {
    issuePanelView.set(projectId, { ...view, ...next })
  }

  /** The listing page is deliberately local: changing the listing resets it. */
  let page = $state(1)

  const selectedIssue = $derived(view.selectedIssue)
  let creating = $state(false)
  let newTitle = $state('')
  let newBody = $state('')
  const creatingBusy = $derived(gitState.isBusy('issue-create'))

  let metadata = $state<{ mode: PrMetadataMode; issue: IssueSummary } | null>(null)
  const metadataBusy = $derived(gitState.isBusy('issue-metadata'))

  let confirmingClose = $state<IssueSummary | null>(null)
  const stateBusy = $derived(gitState.isBusy('issue-state'))

  /** The issue the detail reader draws, resolved from the cached bundle. */
  const metadataSubject = $derived(
    metadata && identity
      ? (gitState.issueBundles[
          GitState.issueBundleKey(identity.owner, identity.repo, metadata.issue.number)
        ]?.detail ?? metadata.issue)
      : null
  )

  function selectState(next: PrState): void {
    page = 1
    patch({ listState: next })
  }

  function selectFilter(next: IssueListFilter): void {
    page = 1
    patch({ listFilter: next })
  }

  function selectSort(next: IssueListSort): void {
    page = 1
    patch({ listSort: next })
  }

  function openIssue(issue: IssueSummary): void {
    patch({ selectedIssue: issue })
  }

  function closeReader(): void {
    patch({ selectedIssue: null })
  }

  /** Hand one issue to an agent, reading its description first so the brief has it. */
  async function workOn(issue: IssueSummary): Promise<void> {
    if (!identity) return
    await gitState.ensureIssueBundle(projectId, identity.owner, identity.repo, issue.number)
    const body =
      gitState.issueBundles[GitState.issueBundleKey(identity.owner, identity.repo, issue.number)]
        ?.detail.body ?? null
    await assignAgentToIssue(projectId, issue, `${identity.owner}/${identity.repo}`, body)
  }

  /**
   * Open the create-PR sheet prefilled to close the issue.
   *
   * The description carries GitHub's own closing keyword, so merging the pull
   * request resolves the issue, and the link makes the connection visible to a
   * reader who arrives at the pull request first.
   */
  function createPullRequest(issue: IssueSummary): void {
    prLifecycleStore.open(projectId, threadId, scopeBucketId || DEFAULT_SCOPE_BUCKET_ID, {
      title: issue.title,
      body: `Closes #${issue.number}\n\n${issue.url}`
    })
  }

  async function applyState(issue: IssueSummary, state: 'open' | 'closed'): Promise<void> {
    if (!identity) return
    const reference = await gitState.setIssueState(
      projectId,
      identity.owner,
      identity.repo,
      issue.number,
      state
    )
    if (!reference) return
    // The reader follows the subject it opened on, so a state change updates the
    // open issue's header rather than leaving it claiming the old state.
    if (selectedIssue?.number === issue.number) {
      patch({ selectedIssue: { ...selectedIssue, state, stateReason: null } })
    }
  }

  async function createIssue(): Promise<void> {
    const title = newTitle.trim()
    if (!title || creatingBusy) return
    const reference = await gitState.createIssue(projectId, {
      title,
      ...(newBody.trim() ? { body: newBody } : {})
    })
    if (!reference) return
    creating = false
    newTitle = ''
    newBody = ''
    if (identity) {
      await gitState.ensureIssuePage(
        projectId,
        identity.owner,
        identity.repo,
        view.listState,
        1,
        { filter: view.listFilter, sort: view.listSort },
        true
      )
      patch({
        selectedIssue: {
          number: reference.number,
          title: reference.title,
          url: reference.url,
          state: 'open',
          stateReason: null,
          authorLogin: '',
          authorAvatarUrl: null,
          authorIsBot: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          comments: 0
        }
      })
    }
  }

  function handleAction(action: import('./issue-view').IssueListAction): void {
    const issue = action.targets[0]
    if (!issue) return
    switch (action.kind) {
      case 'open':
        openIssue(issue)
        return
      case 'open-in-browser':
        void openInBrowser(issue.url)
        return
      case 'copy-links':
        void copyText(action.targets.map((target) => target.url).join('\n')).catch(() => undefined)
        return
      case 'close':
        confirmingClose = issue
        return
      case 'reopen':
        void applyState(issue, 'open')
        return
      case 'labels':
      case 'assignees':
      case 'milestone':
        metadata = { mode: action.kind, issue }
        return
      case 'work-on':
        void workOn(issue)
        return
      case 'create-pr':
        createPullRequest(issue)
        return
    }
  }
</script>

{#if selectedIssue && identity}
  <div class="h-full min-h-0">
    <GitIssueDetail
      {projectId}
      {identity}
      issue={selectedIssue}
      onBack={closeReader}
      onWorkOn={(issue) => void workOn(issue)}
      onCreatePr={createPullRequest}
      onEditMetadata={(mode, issue) => (metadata = { mode, issue })}
      onStateChange={(issue, state) => void applyState(issue, state)}
      onOpenInBrowser={(issue) => void openInBrowser(issue.url)}
    />
  </div>
{:else}
  <div class="h-full min-h-0">
    <GitIssueList
      {projectId}
      {identity}
      {githubConnected}
      state={view.listState}
      filter={view.listFilter}
      sort={view.listSort}
      {page}
      showControls
      onOpen={openIssue}
      {onSignIn}
      onCreate={() => (creating = true)}
      onStateChange={selectState}
      onFilterChange={selectFilter}
      onSortChange={selectSort}
      onPageChange={(next) => (page = next)}
      onAction={handleAction}
    />
  </div>
{/if}

{#if creating}
  <Modal open title="New issue" onClose={() => (creating = false)}>
    <div class="space-y-3">
      <label class="block">
        <span class="mb-1 block text-[0.625rem] font-medium text-muted">Title</span>
        <input
          class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Issue title"
          bind:value={newTitle}
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[0.625rem] font-medium text-muted">Description</span>
        <textarea
          class="min-h-32 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Describe the problem, what you expected, and anything you tried."
          bind:value={newBody}></textarea>
      </label>
      <p class="text-[0.5625rem] leading-relaxed text-dimmed">
        Labels, assignees, and a milestone can be set from the issue once it is created.
      </p>
    </div>

    {#snippet footer()}
      <button
        type="button"
        class="rounded-lg border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
        data-modal-dismiss
        onclick={() => (creating = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        disabled={creatingBusy || newTitle.trim().length === 0}
        onclick={() => void createIssue()}
      >
        {#if creatingBusy}
          <Loader2 size={14} class="animate-spin" />
        {/if}
        Create issue
      </button>
    {/snippet}
  </Modal>
{/if}

{#if metadata && identity && metadataSubject}
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
    onClose={() => (metadata = null)}
    onSave={async (selection) => {
      if (!identity) return { status: 'failed', message: 'No GitHub repository is configured.' }
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
  confirmLabel="Close issue"
  variant="primary"
  busy={stateBusy}
  onCancel={() => (confirmingClose = null)}
  onConfirm={() => {
    const issue = confirmingClose
    confirmingClose = null
    if (issue) void applyState(issue, 'closed')
  }}
>
  <p class="text-xs leading-relaxed text-muted">
    The issue is closed on GitHub as completed. It stays readable and can be reopened.
  </p>
</ConfirmDialog>
