<script lang="ts">
  import CioSearch from 'cio-icon/CioSearch.svelte'
  import CioSpinner from 'cio-icon/CioSpinner.svelte'
  import { onDestroy, onMount } from 'svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { issueStateIcon } from './issue-view'
  import type { IssueRelationshipMode, IssueSummary } from '$shared/types'

  /**
   * Choosing an issue to relate this one to.
   *
   * One dialog for all four relationships because they are one question: pick an
   * issue. What differs is which side of the link this issue takes, and that is the
   * `mode`, so the direction is decided here rather than by four near-identical
   * dialogs.
   *
   * The search is text over the repository's issues, in GitHub's own search syntax,
   * and it re-queries as the reader types. Both sides of a link are node ids, which
   * is why a candidate has to arrive with one: an issue without a node id cannot be
   * linked, so it is not offered.
   */
  interface Props {
    projectId: string
    owner: string
    repo: string
    /** The issue the reader has open, which every write here is written against. */
    issueNumber: number
    /** That issue's GraphQL node id, the local side of every link. */
    issueNodeId: string
    mode: IssueRelationshipMode
    /** Issue numbers already related, so they are not offered a second time. */
    excluded: number[]
    onClose: () => void
  }

  let { projectId, owner, repo, issueNumber, issueNodeId, mode, excluded, onClose }: Props =
    $props()

  /** How long typing settles before the search runs, so a word is one request. */
  const SEARCH_DEBOUNCE_MS = 300

  const busy = $derived(gitState.isBusy('issue-candidates'))
  const saving = $derived(gitState.isBusy('issue-relationship'))

  let text = $state('')
  let results = $state<IssueSummary[]>([])
  let searched = $state(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  const title = $derived(
    mode === 'sub-issue'
      ? 'Add a sub-issue'
      : mode === 'parent'
        ? 'Set the parent issue'
        : mode === 'blocked-by'
          ? 'Add an issue that blocks this one'
          : 'Add an issue this one blocks'
  )

  async function search(): Promise<void> {
    const found = await gitState.searchIssueCandidates(projectId, owner, repo, text)
    // The issue itself and everything already related is filtered out here rather
    // than excluded in the query: GitHub's search has no "not number" qualifier, and
    // offering a row that would fail is worse than not offering it.
    results = found.filter((item) => item.number !== issueNumber && !excluded.includes(item.number))
    searched = true
  }

  function onInput(event: Event): void {
    text = (event.target as HTMLInputElement).value
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS)
  }

  /**
   * Write the link for the chosen issue.
   *
   * The mode decides which issue holds which side: adding a sub-issue makes the
   * chosen issue the child, while setting a parent makes this issue the child. Both
   * are the same mutation with the two ids the other way round, which is why the
   * direction lives here.
   */
  function write(relatedNodeId: string): Promise<boolean> {
    switch (mode) {
      case 'sub-issue':
        return gitState.addIssueSubIssue(
          projectId,
          owner,
          repo,
          issueNumber,
          issueNodeId,
          relatedNodeId
        )
      case 'parent':
        return gitState.addIssueSubIssue(
          projectId,
          owner,
          repo,
          issueNumber,
          relatedNodeId,
          issueNodeId
        )
      case 'blocked-by':
        return gitState.addIssueBlockedBy(
          projectId,
          owner,
          repo,
          issueNumber,
          issueNodeId,
          relatedNodeId
        )
      case 'blocking':
        return gitState.addIssueBlockedBy(
          projectId,
          owner,
          repo,
          issueNumber,
          relatedNodeId,
          issueNodeId
        )
    }
  }

  async function choose(item: IssueSummary): Promise<void> {
    if (!item.nodeId || saving) return
    const landed = await write(item.nodeId)
    // Stays open on failure: the store has set the error, and closing would hide the
    // reason the choice did not take.
    if (landed) onClose()
  }

  onMount(() => {
    void search()
  })

  onDestroy(() => {
    if (timer) clearTimeout(timer)
  })
</script>

<Modal open {title} {onClose}>
  <div class="space-y-2">
    <div class="relative">
      <CioSearch size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed" />
      <input
        class="h-8 w-full border border-border bg-elevated pl-7 pr-2.5 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
        placeholder={`Search ${owner}/${repo} issues`}
        aria-label="Search issues"
        value={text}
        oninput={onInput}
      />
    </div>

    <div class="max-h-72 min-h-24 overflow-y-auto border border-border">
      {#if busy && !searched}
        <div class="flex items-center justify-center gap-2 py-8 text-[0.6875rem] text-dimmed">
          <CioSpinner size={12} class="animate-spin" />
          Searching…
        </div>
      {:else if results.length === 0}
        <p class="px-2.5 py-8 text-center text-[0.6875rem] text-dimmed">
          {text.trim()
            ? `No issues in ${owner}/${repo} match that.`
            : `No other issues in ${owner}/${repo} yet.`}
        </p>
      {:else}
        {#each results as item (item.number)}
          {@const StateIcon = issueStateIcon(item)}
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 border-b border-border px-2.5 py-1.5 text-left last:border-b-0 hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
            title={`Relate #${item.number}: ${item.title}`}
            disabled={saving || !item.nodeId}
            onclick={() => void choose(item)}
          >
            <StateIcon
              size={11}
              class="shrink-0 {item.state === 'closed' ? 'text-dimmed' : 'text-success'}"
            />
            <span class="shrink-0 font-mono text-[0.625rem] text-dimmed">#{item.number}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-foreground">{item.title}</span>
            {#if item.labels && item.labels.length > 0}
              <span class="shrink-0 text-[0.5625rem] text-dimmed">{item.labels[0].name}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      data-modal-dismiss
      onclick={onClose}
    >
      Cancel
    </button>
  {/snippet}
</Modal>
