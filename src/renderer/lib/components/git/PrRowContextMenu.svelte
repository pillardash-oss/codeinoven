<script lang="ts">
  import {
    Bot,
    Check,
    Copy,
    ExternalLink,
    GitBranch,
    GitMerge,
    GitPullRequest,
    ListChecks,
    MessageCircleDashed,
    MessageSquareDashed,
    Milestone,
    RotateCcw,
    Tag,
    UserPlus,
    X
  } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { PullRequestSummary } from '$shared/types'

  /**
   * The actions a pull request row offers on right-click.
   *
   * Two scopes live in this one menu, and the separators are what keep them
   * honest. Lifecycle and clipboard actions apply to every row the selection
   * names, so the row a backlog sweep starts on never decides how many close. Every
   * other action addresses exactly one pull request, and those rows are drawn only
   * when the selection is that one pull request, because "explain" nineteen pull
   * requests is not a question anyone asked.
   *
   * `GitChangesTree` already wraps git rows this way, so a pull request row answers
   * a right-click exactly as a changed file does.
   */
  interface Props {
    /** The row that was right-clicked. */
    pr: PullRequestSummary
    /** Every row the batch actions act on: the whole selection, or this row alone. */
    targets: PullRequestSummary[]
    children: Snippet
    onOpen: (pr: PullRequestSummary) => void
    onOpenInBrowser: (pr: PullRequestSummary) => void
    onCopyLinks: (targets: PullRequestSummary[]) => void
    onCopyBranches: (targets: PullRequestSummary[]) => void
    onClosePullRequests: (targets: PullRequestSummary[]) => void
    onReopenPullRequests: (targets: PullRequestSummary[]) => void
    onExplain: (pr: PullRequestSummary) => void
    onQuickChat: (pr: PullRequestSummary) => void
    /** Hand this one pull request to an agent to triage, test, and report back on. */
    onAssignAgent: (pr: PullRequestSummary) => void
    /** Thread an assignment on this row is already running in, when there is one. */
    assignedThreadId?: string | null
    onOpenAgentThread: (threadId: string) => void
    onMerge: (pr: PullRequestSummary, method: 'merge' | 'squash' | 'rebase') => void
    onMarkReady: (pr: PullRequestSummary) => void
    onEditLabels: (pr: PullRequestSummary) => void
    onEditAssignees: (pr: PullRequestSummary) => void
    onEditMilestone: (pr: PullRequestSummary) => void
    /** Select every row the current page holds, for a sweep. */
    onSelectAll: () => void
    onClearSelection: () => void
  }

  let {
    pr,
    targets,
    children,
    onOpen,
    onOpenInBrowser,
    onCopyLinks,
    onCopyBranches,
    onClosePullRequests,
    onReopenPullRequests,
    onExplain,
    onQuickChat,
    onAssignAgent,
    assignedThreadId = null,
    onOpenAgentThread,
    onMerge,
    onMarkReady,
    onEditLabels,
    onEditAssignees,
    onEditMilestone,
    onSelectAll,
    onClearSelection
  }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'

  const single = $derived(targets.length === 1)
  /**
   * A merged pull request is closed in GitHub's own terms but cannot be reopened,
   * so reopen only ever addresses rows whose state is literally `closed`, and close
   * only ever addresses rows that are still open. Each menu row therefore names the
   * count it will actually act on rather than the size of the selection.
   */
  const closable = $derived(targets.filter((target) => target.state === 'open'))
  const reopenable = $derived(targets.filter((target) => target.state === 'closed'))
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="contents">
    {@render children()}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      avoidCollisions
      collisionPadding={12}
      sticky="always"
      updatePositionStrategy="always"
      class="z-50 max-h-[calc(100vh-1.5rem)] min-w-52 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      <p class="px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
        {#if single}
          Pull request #{pr.number}
        {:else}
          {targets.length} pull requests
        {/if}
      </p>

      {#if single}
        <ContextMenu.Item class={itemClass} onSelect={() => onOpen(pr)}>
          <GitPullRequest size={13} class="shrink-0 text-muted" />
          Open
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={() => onOpenInBrowser(pr)}>
          <ExternalLink size={13} class="shrink-0 text-muted" />
          Open pull request on GitHub
        </ContextMenu.Item>
      {/if}

      <ContextMenu.Separator class="my-1 h-px bg-border" />

      <ContextMenu.Item class={itemClass} onSelect={() => onCopyLinks(targets)}>
        <Copy size={13} class="shrink-0 text-muted" />
        {single ? 'Copy link' : `Copy ${targets.length} links`}
      </ContextMenu.Item>
      <ContextMenu.Item class={itemClass} onSelect={() => onCopyBranches(targets)}>
        <GitBranch size={13} class="shrink-0 text-muted" />
        {single ? 'Copy branch name' : `Copy ${targets.length} branch names`}
      </ContextMenu.Item>

      {#if closable.length > 0 || reopenable.length > 0}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        {#if closable.length > 0}
          <ContextMenu.Item
            class="{itemClass} text-danger data-[highlighted]:bg-danger/10"
            onSelect={() => onClosePullRequests(closable)}
          >
            <X size={13} class="shrink-0" />
            {closable.length === 1
              ? 'Close pull request'
              : `Close ${closable.length} pull requests`}
          </ContextMenu.Item>
        {/if}
        {#if reopenable.length > 0}
          <ContextMenu.Item class={itemClass} onSelect={() => onReopenPullRequests(reopenable)}>
            <RotateCcw size={13} class="shrink-0 text-muted" />
            {reopenable.length === 1
              ? 'Reopen pull request'
              : `Reopen ${reopenable.length} pull requests`}
          </ContextMenu.Item>
        {/if}
      {/if}

      {#if single}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item class={itemClass} onSelect={() => onExplain(pr)}>
          <MessageCircleDashed size={13} class="shrink-0 text-muted" />
          Explain this pull request
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={() => onQuickChat(pr)}>
          <MessageSquareDashed size={13} class="shrink-0 text-muted" />
          Quick chat about this pull request
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={() => onAssignAgent(pr)}>
          <Bot size={13} class="shrink-0 text-muted" />
          Assign to an agent
        </ContextMenu.Item>
        {#if assignedThreadId}
          <!--
            The row above starts an assignment; this one goes back to the assignment
            already running, which is a different question and the one a user asks
            after the agent has had time to work.
          -->
          <ContextMenu.Item class={itemClass} onSelect={() => onOpenAgentThread(assignedThreadId)}>
            <Bot size={13} class="shrink-0 text-primary" />
            Open agent thread
          </ContextMenu.Item>
        {/if}

        {#if pr.state === 'open'}
          <ContextMenu.Separator class="my-1 h-px bg-border" />
          {#if pr.draft}
            <ContextMenu.Item class={itemClass} onSelect={() => onMarkReady(pr)}>
              <Check size={13} class="shrink-0 text-muted" />
              Mark ready for review
            </ContextMenu.Item>
          {/if}
          <!--
            The three methods are separate rows rather than a submenu with a
            confirmation: the method is the decision, and it is the one parameter of
            a merge that changes what the commit history looks like.
          -->
          <ContextMenu.Item class={itemClass} onSelect={() => onMerge(pr, 'merge')}>
            <GitMerge size={13} class="shrink-0 text-muted" />
            Merge commit into {pr.baseRef}…
          </ContextMenu.Item>
          <ContextMenu.Item class={itemClass} onSelect={() => onMerge(pr, 'squash')}>
            <GitMerge size={13} class="shrink-0 text-muted" />
            Squash and merge into {pr.baseRef}…
          </ContextMenu.Item>
          <ContextMenu.Item class={itemClass} onSelect={() => onMerge(pr, 'rebase')}>
            <GitMerge size={13} class="shrink-0 text-muted" />
            Rebase and merge into {pr.baseRef}…
          </ContextMenu.Item>
        {/if}

        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item class={itemClass} onSelect={() => onEditLabels(pr)}>
          <Tag size={13} class="shrink-0 text-muted" />
          Labels…
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={() => onEditAssignees(pr)}>
          <UserPlus size={13} class="shrink-0 text-muted" />
          Assign…
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={() => onEditMilestone(pr)}>
          <Milestone size={13} class="shrink-0 text-muted" />
          Milestone…
        </ContextMenu.Item>
      {/if}

      <ContextMenu.Separator class="my-1 h-px bg-border" />
      <ContextMenu.Item class={itemClass} onSelect={onSelectAll}>
        <ListChecks size={13} class="shrink-0 text-muted" />
        Select every row
      </ContextMenu.Item>
      <ContextMenu.Item class={itemClass} onSelect={onClearSelection}>
        <X size={13} class="shrink-0 text-muted" />
        Clear selection
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
