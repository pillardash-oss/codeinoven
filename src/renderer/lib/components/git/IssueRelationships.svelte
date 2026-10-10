<script lang="ts">
  import { Ban, CornerDownRight, Link2, ListTree } from '@lucide/svelte'
  import { issueStateIcon } from './issue-view'
  import type { IssueRelationshipItem, IssueRelationships } from '$shared/types'

  /**
   * An issue's relationships, drawn the way its own sidebar draws them.
   *
   * Four groups, each a labelled line of chips: the parent this issue belongs to,
   * the sub-issues under it with how many are done, the issues that block it, and
   * the issues it blocks. Grouped rather than merged because the direction is the
   * whole meaning: "blocked by #12" and "blocks #12" are opposite facts.
   *
   * A related issue in another repository links out to github.com, because the
   * reader cannot open an issue in a repository it is not pointed at. Everything
   * else goes through `onOpenIssue`, so a relationship is a way to move around the
   * repository rather than a dead label.
   */
  interface Props {
    /** Owner/repo this issue is in, which tells a local link from a remote one. */
    repository: string
    /** The relationships, or null while the read is still on its way. */
    relationships: IssueRelationships | null
    /** Open a related issue that lives in this repository. */
    onOpenIssue: (item: IssueRelationshipItem) => void
    /** Open a related issue anywhere else, which leaves the app by definition. */
    onOpenRemote: (item: IssueRelationshipItem) => void
  }

  let { repository, relationships, onOpenIssue, onOpenRemote }: Props = $props()

  /** Whether one related issue lives in a repository this reader can navigate to. */
  function isLocal(item: IssueRelationshipItem): boolean {
    return item.repository === repository
  }

  /** The label a chip carries: `#12` at home, `owner/repo#12` away from it. */
  function label(item: IssueRelationshipItem): string {
    return isLocal(item) ? `#${item.number}` : `${item.repository}#${item.number}`
  }

  /** The count of sub-issues that are done, which is the progress GitHub shows. */
  const completedSubIssues = $derived(
    (relationships?.subIssues ?? []).filter((item) => item.state === 'closed').length
  )

  /** True when nothing relates to this issue yet, which is the common case. */
  const empty = $derived(
    relationships !== null &&
      relationships.parent === null &&
      relationships.subIssues.length === 0 &&
      relationships.blockedBy.length === 0 &&
      relationships.blocking.length === 0
  )
</script>

{#snippet chips(items: IssueRelationshipItem[])}
  {#each items as item (`${item.repository}#${item.number}`)}
    {@const StateIcon = issueStateIcon(item)}
    <button
      type="button"
      class="flex h-5 max-w-full cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 text-[0.5625rem] font-medium transition-colors hover:bg-elevated {item.state ===
      'closed'
        ? 'text-dimmed'
        : 'text-muted'}"
      title="{item.repository}#{item.number}: {item.title}"
      onclick={() => (isLocal(item) ? onOpenIssue(item) : onOpenRemote(item))}
    >
      <StateIcon size={8} class="shrink-0" />
      <span class="shrink-0 font-mono">{label(item)}</span>
      <span class="max-w-[18ch] truncate">{item.title}</span>
    </button>
  {/each}
{/snippet}

{#snippet group(labelText: string, items: IssueRelationshipItem[], Icon: typeof Ban, tone: string)}
  <div class="flex items-start gap-1.5">
    <span class="flex shrink-0 items-center gap-1 pt-0.5 text-[0.5625rem] font-medium text-dimmed">
      <Icon size={9} class={tone} />
      {labelText}
    </span>
    <div class="flex min-w-0 flex-1 flex-wrap gap-1">
      {@render chips(items)}
    </div>
  </div>
{/snippet}

<div class="mt-2 rounded-lg border border-border bg-surface/40 px-2.5 py-2">
  <div class="flex items-center gap-1.5">
    <ListTree size={10} class="text-dimmed" />
    <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
      Relationships
    </span>
    <span class="flex-1"></span>
    {#if relationships === null}
      <span class="text-[0.5625rem] text-dimmed">Loading…</span>
    {/if}
  </div>

  {#if relationships !== null}
    {#if empty}
      <!--
        The wording github.com uses when nothing relates to an issue. Saying it is the
        point: a blank panel leaves a reader unsure whether the answer is "none" or
        "not loaded".
      -->
      <p class="mt-1.5 text-[0.625rem] italic text-dimmed">None yet</p>
    {:else}
      <div class="mt-1.5 space-y-1.5">
        {#if relationships.parent}
          {@render group('Parent', [relationships.parent], CornerDownRight, '')}
        {/if}
        {#if relationships.subIssues.length > 0}
          <div class="flex items-start gap-1.5">
            <span
              class="flex shrink-0 items-center gap-1 pt-0.5 text-[0.5625rem] font-medium text-dimmed"
            >
              <ListTree size={9} />
              Sub-issues
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="text-[0.5625rem] text-dimmed">
                {completedSubIssues} of {relationships.subIssues.length} done
              </span>
              <div class="flex flex-wrap gap-1">
                {@render chips(relationships.subIssues)}
              </div>
            </div>
          </div>
        {/if}
        {#if relationships.blockedBy.length > 0}
          {@render group('Blocked by', relationships.blockedBy, Ban, 'text-warning')}
        {/if}
        {#if relationships.blocking.length > 0}
          {@render group('Blocking', relationships.blocking, Link2, '')}
        {/if}
      </div>
    {/if}
  {/if}
</div>
