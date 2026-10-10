<script lang="ts">
  import { Ban, CornerDownRight, Link2, ListTree, Plus, X } from '@lucide/svelte'
  import { issueStateIcon } from './issue-view'
  import type {
    IssueRelationshipItem,
    IssueRelationshipMode,
    IssueRelationships
  } from '$shared/types'

  /**
   * An issue's relationships, drawn the way its own sidebar draws them.
   *
   * Four groups, each a labelled line of chips: the parent this issue belongs to,
   * the sub-issues under it with how many are done, the issues that block it, and
   * the issues it blocks. Grouped rather than merged because the direction is the
   * whole meaning: "blocked by #12" and "blocks #12" are opposite facts.
   *
   * A related issue in another repository links out to github.com, because the reader
   * cannot open an issue in a repository it is not pointed at. Everything else goes
   * through `onOpenIssue`, so a relationship is a way to move around the repository
   * rather than a dead label.
   *
   * The add and remove controls are the caller's to perform, and are only offered when
   * this issue has a node id, which is the only handle the writes accept.
   */
  interface Props {
    /** Owner/repo this issue is in, which tells a local link from a remote one. */
    repository: string
    /** The relationships, or null while the read is still on its way. */
    relationships: IssueRelationships | null
    /** This issue's node id, or null when the payload carried none. */
    issueNodeId: string | null
    /** Open a related issue that lives in this repository. */
    onOpenIssue: (item: IssueRelationshipItem) => void
    /** Open a related issue anywhere else, which leaves the app by definition. */
    onOpenRemote: (item: IssueRelationshipItem) => void
    /** Choose an issue to relate to this one. */
    onAdd: (mode: IssueRelationshipMode) => void
    /** Undo a relationship, which the caller confirms first. */
    onRemove: (mode: IssueRelationshipMode, item: IssueRelationshipItem) => void
  }

  let {
    repository,
    relationships,
    issueNodeId,
    onOpenIssue,
    onOpenRemote,
    onAdd,
    onRemove
  }: Props = $props()

  /** True while a link may be changed: both sides need a node id to be addressable. */
  const canLink = $derived(issueNodeId !== null)

  /** Whether one item can be unlinked: a write needs the node id the payload gave. */
  function removable(item: IssueRelationshipItem): boolean {
    return canLink && item.nodeId !== null
  }

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

{#snippet addButton(mode: IssueRelationshipMode, label: string)}
  {#if canLink}
    <button
      type="button"
      class="flex h-5 cursor-pointer items-center gap-0.5 rounded-full border border-dashed border-border px-1.5 text-[0.5625rem] font-medium text-dimmed transition-colors hover:border-primary hover:text-primary"
      title={label}
      aria-label={label}
      onclick={() => onAdd(mode)}
    >
      <Plus size={9} />
      Add
    </button>
  {/if}
{/snippet}

{#snippet chips(items: IssueRelationshipItem[], mode: IssueRelationshipMode)}
  {#each items as item (`${item.repository}#${item.number}`)}
    {@const StateIcon = issueStateIcon(item)}
    <!--
      The open control and the unlink control are siblings, never nested: a button
      inside a button is invalid, and the unlink only appears on hover so a chip the
      reader is not acting on stays a chip.
    -->
    <div
      class="group flex h-5 max-w-full items-center rounded-full border border-border pl-1.5 pr-1 text-[0.5625rem] font-medium transition-colors hover:bg-elevated"
    >
      <button
        type="button"
        class="flex min-w-0 cursor-pointer items-center gap-1 {item.state === 'closed'
          ? 'text-dimmed'
          : 'text-muted'}"
        title="{item.repository}#{item.number}: {item.title}"
        onclick={() => (isLocal(item) ? onOpenIssue(item) : onOpenRemote(item))}
      >
        <StateIcon size={8} class="shrink-0" />
        <span class="shrink-0 font-mono">{label(item)}</span>
        <span class="max-w-[18ch] truncate">{item.title}</span>
      </button>
      {#if removable(item)}
        <button
          type="button"
          class="ml-0.5 flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-full text-dimmed opacity-0 transition-opacity hover:bg-danger/15 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
          title="Unlink {item.repository}#{item.number}"
          aria-label="Unlink {item.repository}#{item.number}"
          onclick={() => onRemove(mode, item)}
        >
          <X size={8} />
        </button>
      {/if}
    </div>
  {/each}
{/snippet}

{#snippet group(
  labelText: string,
  items: IssueRelationshipItem[],
  Icon: typeof Ban,
  tone: string,
  mode: IssueRelationshipMode
)}
  <div class="flex items-start gap-1.5">
    <span class="flex shrink-0 items-center gap-1 pt-0.5 text-[0.5625rem] font-medium text-dimmed">
      <Icon size={9} class={tone} />
      {labelText}
    </span>
    <div class="flex min-w-0 flex-1 flex-wrap gap-1">
      {@render chips(items, mode)}
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
    <div class="mt-1.5 space-y-1.5">
      <!--
        The parent is its own row rather than a fifth group: an issue has at most one,
        so an empty parent is something to offer rather than something to list.
      -->
      {#if relationships.parent}
        {@render group('Parent', [relationships.parent], CornerDownRight, '', 'parent')}
      {:else}
        <div class="flex items-start gap-1.5">
          <span
            class="flex shrink-0 items-center gap-1 pt-0.5 text-[0.5625rem] font-medium text-dimmed"
          >
            <CornerDownRight size={9} />
            Parent
          </span>
          <div class="flex min-w-0 flex-1 flex-wrap gap-1">
            {#if empty}
              <span class="text-[0.5625rem] italic text-dimmed">None yet</span>
            {/if}
            {@render addButton('parent', 'Choose the issue this one is a sub-issue of')}
          </div>
        </div>
      {/if}

      <div class="flex items-start gap-1.5">
        <span
          class="flex shrink-0 items-center gap-1 pt-0.5 text-[0.5625rem] font-medium text-dimmed"
        >
          <ListTree size={9} />
          Sub-issues
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          {#if relationships.subIssues.length > 0}
            <span class="text-[0.5625rem] text-dimmed">
              {completedSubIssues} of {relationships.subIssues.length} done
            </span>
          {/if}
          <div class="flex flex-wrap gap-1">
            {@render chips(relationships.subIssues, 'sub-issue')}
            {@render addButton('sub-issue', 'Add a sub-issue to this one')}
          </div>
        </div>
      </div>

      {#if relationships.blockedBy.length > 0}
        {@render group('Blocked by', relationships.blockedBy, Ban, 'text-warning', 'blocked-by')}
      {:else}
        <div class="flex items-start gap-1.5">
          <span
            class="flex shrink-0 items-center gap-1 pt-0.5 text-[0.5625rem] font-medium text-dimmed"
          >
            <Ban size={9} class="text-warning" />
            Blocked by
          </span>
          <div class="flex min-w-0 flex-1 flex-wrap gap-1">
            {@render addButton('blocked-by', 'Add an issue that blocks this one')}
          </div>
        </div>
      {/if}

      {#if relationships.blocking.length > 0}
        {@render group('Blocking', relationships.blocking, Link2, '', 'blocking')}
      {:else}
        <div class="flex items-start gap-1.5">
          <span
            class="flex shrink-0 items-center gap-1 pt-0.5 text-[0.5625rem] font-medium text-dimmed"
          >
            <Link2 size={9} />
            Blocking
          </span>
          <div class="flex min-w-0 flex-1 flex-wrap gap-1">
            {@render addButton('blocking', 'Add an issue this one blocks')}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
