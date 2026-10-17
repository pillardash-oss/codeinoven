<script lang="ts">
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  import { copyText } from '$lib/copy-text'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState } from '$lib/stores/git.svelte'
  import { issuePanelView, type IssuePanelViewState } from '$lib/stores/issue-panel-view.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import GitIssueList from './GitIssueList.svelte'
  import GitIssueReader from './GitIssueReader.svelte'
  import { composePullRequestForIssue, setIssueState, workOnIssue } from './git-issue-actions'
  import { issueReaderActionFor, type IssueListAction, type IssueReaderAction } from './issue-view'
  import type { IssueListFilter, IssueListSort, IssueSummary, PrState } from '$shared/types'

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
    /**
     * Open a commit the issue reader's history names, in this panel.
     *
     * Forwarded down unchanged: the panel owns the commit view, this view only
     * knows the reader that asked for it.
     */
    onOpenCommit: (commitId: string) => void
  }

  let {
    projectId,
    threadId,
    scopeBucketId,
    identity,
    githubConnected,
    onSignIn,
    onOpenCommit
  }: Props = $props()

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

  /**
   * The reader action a row asked for, handed over as the issue opens.
   *
   * The reader owns every one of them, so a row that offers Label, Assign,
   * Milestone, Close, Reopen, Work on or Create pull request opens the issue and
   * asks the reader to carry it out, rather than a second copy of the behaviour
   * living in the list.
   */
  let readerAction = $state<IssueReaderAction | null>(null)

  const selectedIssue = $derived(view.selectedIssue)
  let creating = $state(false)
  let newTitle = $state('')
  let newBody = $state('')
  const creatingBusy = $derived(gitState.isBusy('issue-create'))

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

  /**
   * The listing's own actions, plus the reader's, raised on the issue it opens.
   *
   * The two that raise a dialog   close, and the metadata pickers   open the
   * issue and ask the reader for it, because the confirmation and the picker are
   * the reader's. The rest are performed here, through the same actions module
   * the reader uses, so a row's Work on the issue is the reader's own brief.
   */
  function handleAction(action: IssueListAction): void {
    const issue = action.targets[0]
    if (!issue) return
    if (action.kind === 'open-in-browser') {
      void openInBrowser(issue.url)
      return
    }
    if (action.kind === 'copy-links') {
      void copyText(action.targets.map((target) => target.url).join('\n')).catch(() => undefined)
      return
    }
    const readerRequest = issueReaderActionFor(action)
    if (readerRequest) {
      openIssue(issue)
      readerAction = readerRequest
      return
    }
    if (!identity) return
    switch (action.kind) {
      case 'work-on':
        void workOnIssue(projectId, identity, issue)
        return
      case 'create-pr':
        composePullRequestForIssue(projectId, threadId, scopeBucketId, issue)
        return
      case 'reopen':
        void reopenIssue(issue)
        return
      default:
        openIssue(issue)
    }
  }

  /** Bring a closed issue back, following it in the reader when it is the open one. */
  async function reopenIssue(issue: IssueSummary): Promise<void> {
    if (!identity) return
    if (!(await setIssueState(projectId, identity, issue, 'open'))) return
    if (selectedIssue?.number === issue.number) {
      patch({ selectedIssue: { ...selectedIssue, state: 'open', stateReason: null } })
    }
  }
</script>

{#if selectedIssue && identity}
  <GitIssueReader
    {projectId}
    {threadId}
    {scopeBucketId}
    {identity}
    issue={selectedIssue}
    onBack={closeReader}
    action={readerAction}
    onActionHandled={() => (readerAction = null)}
    {onOpenCommit}
  />
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
          class="h-8 w-full border border-border bg-elevated px-2.5 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Issue title"
          bind:value={newTitle}
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[0.625rem] font-medium text-muted">Description</span>
        <textarea
          class="min-h-32 w-full resize-y border border-border bg-elevated px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
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
        class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
        data-modal-dismiss
        onclick={() => (creating = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        disabled={creatingBusy || newTitle.trim().length === 0}
        onclick={() => void createIssue()}
      >
        {#if creatingBusy}
          <CioSpinner size={14} class="animate-spin" />
        {/if}
        Create issue
      </button>
    {/snippet}
  </Modal>
{/if}
