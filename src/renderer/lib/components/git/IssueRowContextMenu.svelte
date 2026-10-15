<script lang="ts">
  import {
    CircleDot,
    Copy,
    ExternalLink,
    GitPullRequest,
    Hammer,
    Milestone,
    RotateCcw,
    Tag,
    UserPlus,
    X
  } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { IssueSummary } from '$shared/types'

  /**
   * The actions an issue row offers on right-click.
   *
   * Two scopes, kept apart by separators: the lifecycle and clipboard actions read
   * the issue, while "Work on this issue" and "Create pull request" start new work
   * and so address exactly the one row they were opened on.
   */
  interface Props {
    issue: IssueSummary
    children: Snippet
    onOpen: (issue: IssueSummary) => void
    onOpenInBrowser: (issue: IssueSummary) => void
    onCopyLink: (issue: IssueSummary) => void
    onWorkOn: (issue: IssueSummary) => void
    onCreatePullRequest: (issue: IssueSummary) => void
    onEditLabels: (issue: IssueSummary) => void
    onEditAssignees: (issue: IssueSummary) => void
    onEditMilestone: (issue: IssueSummary) => void
    onClose: (issue: IssueSummary) => void
    onReopen: (issue: IssueSummary) => void
  }

  let {
    issue,
    children,
    onOpen,
    onOpenInBrowser,
    onCopyLink,
    onWorkOn,
    onCreatePullRequest,
    onEditLabels,
    onEditAssignees,
    onEditMilestone,
    onClose,
    onReopen
  }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'
  const separatorClass = 'my-1 h-px bg-border'
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
      class="z-50 max-h-[calc(100vh-1.5rem)] min-w-52 overflow-y-auto border border-border bg-surface p-1 shadow-lg"
    >
      <p class="px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
        Issue #{issue.number}
      </p>
      <ContextMenu.Item class={itemClass} onSelect={() => onOpen(issue)}>
        <CircleDot size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Open
      </ContextMenu.Item>
      <ContextMenu.Item class={itemClass} onSelect={() => onOpenInBrowser(issue)}>
        <ExternalLink size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Open on GitHub
      </ContextMenu.Item>
      <ContextMenu.Item class={itemClass} onSelect={() => onCopyLink(issue)}>
        <Copy size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Copy link
      </ContextMenu.Item>
      <ContextMenu.Separator class={separatorClass} />
      <ContextMenu.Item class={itemClass} onSelect={() => onWorkOn(issue)}>
        <Hammer size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Work on this issue
      </ContextMenu.Item>
      <ContextMenu.Item class={itemClass} onSelect={() => onCreatePullRequest(issue)}>
        <GitPullRequest size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Create pull request
      </ContextMenu.Item>
      <ContextMenu.Separator class={separatorClass} />
      <ContextMenu.Item class={itemClass} onSelect={() => onEditLabels(issue)}>
        <Tag size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Edit labels
      </ContextMenu.Item>
      <ContextMenu.Item class={itemClass} onSelect={() => onEditAssignees(issue)}>
        <UserPlus size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Edit assignees
      </ContextMenu.Item>
      <ContextMenu.Item class={itemClass} onSelect={() => onEditMilestone(issue)}>
        <Milestone size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        Set milestone
      </ContextMenu.Item>
      <ContextMenu.Separator class={separatorClass} />
      {#if issue.state === 'open'}
        <ContextMenu.Item class={itemClass} onSelect={() => onClose(issue)}>
          <X size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
          Close issue
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item class={itemClass} onSelect={() => onReopen(issue)}>
          <RotateCcw size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
          Reopen issue
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
