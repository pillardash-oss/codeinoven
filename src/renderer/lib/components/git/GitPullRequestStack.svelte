<script lang="ts">
  import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
  import type { PullRequestSummary } from '$shared/types'
  import { prStateBadgeClass } from './pr-view'

  interface Props {
    items: PullRequestSummary[]
    currentNumber: number
    error?: string
    onOpen: (pr: PullRequestSummary) => void
  }
  let { items, currentNumber, error, onOpen }: Props = $props()
</script>

{#if error}
  <p class="mt-2 text-[0.625rem] text-warning" role="status">{error}</p>
{:else if items.length > 1}
  <nav class="mt-2 border-t border-border pt-2" aria-label="Stacked pull requests">
    <p class="mb-1 text-[0.625rem] font-medium text-muted">Stacked PRs · {items.length}</p>
    <ol class="max-h-48 overflow-y-auto">
      {#each items as pr, index (pr.number)}
        <li>
          <button
            type="button"
            class="flex w-full cursor-pointer items-start gap-1.5 px-1 py-1 text-left hover:bg-elevated {pr.number ===
            currentNumber
              ? 'bg-elevated'
              : ''}"
            aria-current={pr.number === currentNumber ? 'page' : undefined}
            title={`Open pull request #${pr.number}: ${pr.title}`}
            onclick={() => onOpen(pr)}
          >
            <CioPullRequest
              size={12}
              class="mt-0.5 shrink-0 {prStateBadgeClass(pr.state)}"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[0.625rem] text-foreground"
                >#{pr.number} {pr.title}</span
              >
              <span class="block truncate font-mono text-[0.5625rem] text-dimmed"
                >{pr.headRef} → {pr.baseRef}</span
              >
            </span>
            {#if index === 0}<span class="text-[0.5625rem] text-muted">Root</span>{/if}
            {#if pr.number === currentNumber}
              <span class="text-[0.5625rem] text-muted">Current</span>
            {/if}
          </button>
        </li>
      {/each}
    </ol>
  </nav>
{/if}
