<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import CioPerson from '@pdslng/cio-icon/CioPerson.svelte'
  import { DropdownMenu } from 'bits-ui'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import type { PullRequestSummary } from '$shared/types'
  import { reviewPullRequest } from './pr-review-actions'

  interface Props {
    projectId: string
    pr: PullRequestSummary
    remote: string
  }

  let { projectId, pr, remote }: Props = $props()
  const preparing = $derived(
    scopeJobs.jobs.some(
      (job) =>
        job.projectId === projectId &&
        job.title === `cio-pr-review-${pr.number}` &&
        job.status === 'running'
    )
  )
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 shrink-0 cursor-pointer items-center gap-1 px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40 data-[state=open]:bg-elevated"
    title="Review this pull request in an isolated scope"
    aria-label="Review pull request"
    disabled={preparing}
  >
    <span>{preparing ? 'Preparing review' : 'Review'}</span>
    <CioChevronDown size={10} />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-90 w-48 border border-border bg-surface p-1 shadow-lg"
    >
      <DropdownMenu.Item
        class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
        onSelect={() => void reviewPullRequest(projectId, pr, remote, 'self')}
      >
        <CioPerson size={12} />
        Review yourself
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
        onSelect={() => void reviewPullRequest(projectId, pr, remote, 'agent')}
      >
        <CioSubagent size={12} />
        Review with agent
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
