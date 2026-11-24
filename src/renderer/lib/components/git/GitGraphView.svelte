<script lang="ts">
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import { ContextMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { GitCommitInfo, GitRemoteUpdate } from '$shared/types'
  import { formatCompactAge } from '$shared/date-time-format'
  import {
    GRAPH_LANE_WIDTH,
    GRAPH_MAX_LANES,
    GRAPH_ROW_HEIGHT,
    assignGraphLanes,
    graphLaneColor,
    graphLaneX,
    graphRemotePlacement,
    graphRowEdges,
    isMergeRow,
    type GitGraphRow
  } from '$lib/git-graph'
  import { gitHistoryGroups, type GitHistoryGroup } from '$lib/git-history-groups'
  import type { GitHistoryView } from '$lib/stores/git-panel-view.svelte'
  import { absoluteTime } from './git-status-panel-format'

  interface Props {
    /** Newest first. Paged in by the owning panel's scroll handler. */
    commits: GitCommitInfo[]
    loading: boolean
    loadingMore: boolean
    hasMore: boolean
    /** Local commits not yet on the upstream, marked on the graph. */
    unpushedCount: number
    /** Upstream ref name, for the pushed-boundary label. */
    upstream: string | null
    /**
     * Every recorded movement of the upstream ref, newest first. Each one marks
     * where a batch of commits reached the remote, so the graph can show a push
     * of five commits separately from the push of two that followed it, and can
     * still name the commits a later rewrite took back off the remote.
     */
    remoteUpdates: GitRemoteUpdate[]
    /** Hash of the commit whose diff is currently shown, if any. */
    selectedHash: string | null
    /** How the same commits are presented: the upstream's batches, or the lanes. */
    view: GitHistoryView
    onSelectCommit: (commit: GitCommitInfo) => void
    /** The owning panel supplies the per-commit actions menu. */
    menu: Snippet<[{ commit: GitCommitInfo; isHead: boolean }]>
  }

  let {
    commits,
    loading,
    loadingMore,
    hasMore,
    unpushedCount,
    upstream,
    remoteUpdates,
    selectedHash,
    view,
    onSelectCommit,
    menu
  }: Props = $props()

  // The single forward pass is O(commits) and re-runs only when the list
  // changes; appending an older page leaves the rows above untouched.
  const rows = $derived.by(() => assignGraphLanes(commits))

  const laneColumnWidth = $derived.by(() => {
    let widest = 1
    for (const row of rows) widest = Math.max(widest, row.laneCount)
    return Math.min(widest, GRAPH_MAX_LANES) * GRAPH_LANE_WIDTH
  })

  /** True once history needs more lanes than the column draws. */
  const lanesClipped = $derived(rows.some((row) => row.laneCount > GRAPH_MAX_LANES))

  /**
   * Where the recorded movements land: a live boundary for every batch the
   * upstream still holds, and a rewrite mark on every commit a recorded movement
   * put on the ref that the upstream has since moved off.
   */
  const placement = $derived(graphRemotePlacement(rows, remoteUpdates, unpushedCount))

  /**
   * The same rows read as the batches the upstream saw, which is the default
   * presentation: the local-only run, then each movement of the ref, newest
   * first. It is a reshaping of `rows`, never a second fetch.
   */
  const groups = $derived(
    gitHistoryGroups({ rows, placement, unpushedCount, upstream: upstream ?? null })
  )

  /**
   * True when no movement the upstream still holds lands on the unpushed
   * boundary, so the graph's plain "Pushed to <upstream>" line still has to be
   * drawn. That is the case when the reflog is gone past git's expiry, or when
   * the remote was never fetched from this clone, and the split between pushed
   * and unpushed is still real.
   */
  const needsPlainBoundary = $derived(
    unpushedCount > 0 && unpushedCount < rows.length && !placement.boundaries.has(unpushedCount)
  )

  const groupLabel = (group: GitHistoryGroup): string => {
    if (group.kind === 'unpushed') return 'Unpushed'
    // No upstream means there is nothing to be pushed to or received from: the
    // batch is just history, and saying otherwise would invent a remote.
    if (group.ref === null) return 'Local history'
    return group.kind === 'received' ? `Received from ${group.ref}` : `Pushed to ${group.ref}`
  }

  /**
   * The last thing the upstream is known to have done with a commit it was
   * rewritten off, as a sentence for that row's tooltip. The rewrite itself has
   * no time here (a fetch only reports that the ref was already gone), so the
   * moment given is when the ref last pointed at the commit.
   */
  function rewriteLabel(update: GitRemoteUpdate, upstreamRef: string | null): string {
    const ref = update.ref || upstreamRef || 'the remote'
    const reached = update.at === null ? '' : ` on ${absoluteTime(update.at)}`
    // Same wording as the boundary lines, so the mark reads as the other half of
    // the same story: the batch went up, and a later rewrite took it off.
    const published = update.kind === 'push' ? `Pushed to ${ref}` : `Received from ${ref}`
    return `${published}${reached}; no longer on it, the remote was rewritten off it.`
  }
</script>

<!--
  A line where a batch of commits reached the remote, and what happened to it:
  `Pushed to` is this checkout publishing them, `Received from` is this clone
  learning they were already there (a fetch, a pull, a clone, or a peer's push
  that only arrived here on the next fetch). Git stamps the movement itself, so
  the batch below the line went up in one action, which is what makes a five
  commit push readable as separate from the two commit one that followed it.

  A null update is the fallback for a boundary git kept no record of (an expired
  reflog, or a clone that never fetched): the split between pushed and unpushed
  is still real, only its moment is unknown.
-->
{#snippet batchBoundary(update: GitRemoteUpdate | null)}
  {@const direction = update === null || update.kind === 'push' ? 'Pushed to' : 'Received from'}
  {@const ref = update?.ref ?? upstream ?? 'the remote'}
  {@const at = update?.at ?? null}
  <div class="flex items-center gap-2 px-2 py-1">
    <span class="h-px flex-1 bg-border"></span>
    <span
      class="flex shrink-0 items-center gap-1 text-[0.5625rem] font-medium text-dimmed"
      title={`${direction} ${ref}${at === null ? '' : ` on ${absoluteTime(at)}`}`}
    >
      {#if direction === 'Pushed to'}
        <CioUpload size={10} class="shrink-0" aria-hidden="true" />
      {:else}
        <CioDownload size={10} class="shrink-0" aria-hidden="true" />
      {/if}
      {direction}
      {ref}{at === null ? '' : ` · ${formatCompactAge(at)}`}
    </span>
    <span class="h-px flex-1 bg-border"></span>
  </div>
{/snippet}

<!--
  One batch, named the way the upstream sees it. The grouped view draws these
  instead of boundary lines: the heading carries the movement and its moment,
  the rows below it are the commits that arrived together, and the count says
  how many. Unpushed is the one batch with no movement behind it, so it is the
  one heading that is tinted: it is the only part of history the remote does not
  have.
-->
{#snippet groupHeader(group: GitHistoryGroup)}
  {@const at = group.update?.at ?? null}
  <div
    class={[
      'flex items-center gap-1.5 border-y border-border px-2 py-1',
      group.kind === 'unpushed' ? 'bg-warning/10' : 'bg-elevated/40'
    ]}
  >
    <span
      class={[
        'flex shrink-0 items-center gap-1 text-[0.5625rem] font-semibold',
        group.kind === 'unpushed' ? 'text-warning' : 'text-muted'
      ]}
      title={at === null ? groupLabel(group) : `${groupLabel(group)} on ${absoluteTime(at)}`}
    >
      {#if group.kind === 'received'}
        <CioDownload size={10} class="shrink-0" aria-hidden="true" />
      {:else if group.update !== null || group.ref !== null}
        <CioUpload size={10} class="shrink-0" aria-hidden="true" />
      {:else}
        <CioCommit size={10} class="shrink-0" aria-hidden="true" />
      {/if}
      {groupLabel(group)}
    </span>
    {#if at !== null}
      <span class="min-w-0 truncate text-[0.5625rem] text-dimmed">· {absoluteTime(at)}</span>
    {/if}
    <span class="ml-auto shrink-0 text-[0.5625rem] tabular-nums text-dimmed">
      {group.entries.length}
      {group.entries.length === 1 ? 'commit' : 'commits'}
    </span>
  </div>
{/snippet}

<!--
  One commit, shared by both presentations so the two can never drift: the lane
  column, the subject, the refs it wears, the author and the hash. A merge is a
  ring instead of a dot, which is the only node shape that differs.
-->
{#snippet commitRow(entry: { index: number; row: GitGraphRow })}
  {@const row = entry.row}
  {@const index = entry.index}
  {@const edges = graphRowEdges(row)}
  {@const subject = row.commit.message.split('\n')[0] ?? ''}
  <!--
      Commits above the pushed boundary are local only, so their node is amber
      instead of the lane colour: lane 0 paints in `--color-primary`, which is
      near-black in the light theme and near-white in the dark one, and a
      monochrome dot is exactly what hid the pushed/not-pushed split. A commit
      the upstream was rewritten off keeps that amber and gains a badge: it is
      missing from the remote for the same reason, only it got there once.
    -->
  {@const pushed = index >= unpushedCount}
  {@const rewrittenBy = placement.rewritten.get(index) ?? null}
  {@const syncLabel =
    rewrittenBy !== null
      ? rewriteLabel(rewrittenBy, upstream)
      : upstream === null
        ? 'No upstream configured'
        : pushed
          ? `Pushed to ${upstream}`
          : `Not pushed to ${upstream} yet`}
  {@const merge = isMergeRow(row)}
  {@const nodeColor = pushed ? graphLaneColor(row.lane) : 'var(--color-warning)'}
  <ContextMenu.Root>
    <ContextMenu.Trigger
      class="block w-full"
      aria-label={`Actions for commit ${row.commit.shortHash}`}
    >
      <div
        class={[
          'flex items-stretch',
          selectedHash === row.commit.hash ? 'bg-primary/10' : 'hover:bg-elevated/50'
        ]}
      >
        <svg
          width={laneColumnWidth}
          height={GRAPH_ROW_HEIGHT}
          class="shrink-0 overflow-hidden"
          aria-hidden="true"
        >
          {#each edges as edge, edgeIndex (edgeIndex)}
            <path d={edge.path} fill="none" stroke={edge.color} stroke-width="1.5" />
          {/each}
          {#if !pushed && !merge}
            <!-- A soft halo, so the unpushed run reads as a block at a glance
                 without the amber having to shout over the lane colours. -->
            <circle
              cx={graphLaneX(row.lane)}
              cy={GRAPH_ROW_HEIGHT / 2}
              r="5"
              fill="var(--color-warning)"
              opacity="0.18"
            />
          {/if}
          {#if merge}
            <!-- A merge is where a lane ends and another continues: the ring
                 says "two histories met here" at a glance, which no dot can. -->
            <circle
              cx={graphLaneX(row.lane)}
              cy={GRAPH_ROW_HEIGHT / 2}
              r="4"
              fill="var(--color-app)"
              stroke={nodeColor}
              stroke-width="1.5"
            />
            <circle cx={graphLaneX(row.lane)} cy={GRAPH_ROW_HEIGHT / 2} r="1.25" fill={nodeColor} />
          {:else}
            <circle
              cx={graphLaneX(row.lane)}
              cy={GRAPH_ROW_HEIGHT / 2}
              r="3"
              fill={nodeColor}
              stroke="var(--color-app)"
              stroke-width="1.5"
            />
          {/if}
        </svg>
        <button
          type="button"
          class={[
            'flex min-w-0 flex-1 items-center gap-2 px-2 text-left',
            pushed ? 'text-foreground' : 'text-muted'
          ]}
          style={`height: ${GRAPH_ROW_HEIGHT}px`}
          title={`View ${row.commit.shortHash}: ${subject}. ${row.commit.author}. ${syncLabel}`}
          aria-label={`View commit ${row.commit.shortHash}: ${subject}. ${row.commit.author}. ${syncLabel}`}
          onclick={() => onSelectCommit(row.commit)}
        >
          <span class="min-w-0 flex-1 truncate text-[0.6875rem] leading-snug">
            {subject}
          </span>
          {#if rewrittenBy !== null}
            <!-- Amber like the unpushed run it sits in, because the commit is
                 not on the remote now; the badge is what says it was there
                 once, and the row's tooltip names the movement and its time. -->
            <span class="shrink-0 bg-warning/10 px-1 py-px text-[0.5rem] font-medium text-warning">
              rewritten
            </span>
          {/if}
          {#each row.commit.refs as ref (ref.head ? `head:${ref.name}` : `${ref.kind}:${ref.name}`)}
            <span
              class={[
                'shrink-0 px-1 py-px text-[0.5rem] font-medium',
                ref.head
                  ? 'bg-primary text-on-primary'
                  : ref.kind === 'tag'
                    ? 'bg-accent/15 text-accent'
                    : 'bg-primary/15 text-primary'
              ]}
            >
              {ref.name}
            </span>
          {/each}
          <span class="max-w-16 shrink-0 truncate text-[0.5625rem] text-dimmed">
            {row.commit.author}
          </span>
          <span class="shrink-0 font-mono text-[0.5625rem] text-dimmed">
            {row.commit.shortHash}
          </span>
          <span class="shrink-0 text-[0.5625rem] text-dimmed">
            {formatCompactAge(row.commit.date)}
          </span>
        </button>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content
        class="z-50 min-w-48 overflow-hidden border border-border bg-surface p-1 shadow-xl"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
      >
        {@render menu({ commit: row.commit, isHead: index === 0 })}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
{/snippet}

{#if loading}
  <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
    <CioSpinner size={14} class="animate-spin" />
    Loading history
  </div>
{:else if rows.length === 0}
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <CioCommit size={22} class="mx-auto mb-2 text-dimmed" />
    <p class="text-xs font-medium text-muted">No commits yet</p>
    <p class="mt-1 text-[0.625rem] text-dimmed">Make your first commit to see history.</p>
  </div>
{:else}
  {#if lanesClipped}
    <p class="px-3 pb-1 pt-2 text-[0.5625rem] text-dimmed">
      Showing the first {GRAPH_MAX_LANES} lanes of history
    </p>
  {/if}

  {#if view === 'grouped'}
    {#each groups as group (group.key)}
      {@render groupHeader(group)}
      {#each group.entries as entry (entry.row.commit.hash)}
        {@render commitRow(entry)}
      {/each}
    {/each}
  {:else}
    {#each rows as row, index (row.commit.hash)}
      {@const batchStart = placement.boundaries.get(index) ?? null}
      {#if batchStart}
        {@render batchBoundary(batchStart)}
      {:else if needsPlainBoundary && index === unpushedCount}
        {@render batchBoundary(null)}
      {/if}
      {@render commitRow({ index, row })}
    {/each}
  {/if}

  {#if loadingMore}
    <div class="flex items-center justify-center gap-2 py-4 text-[0.625rem] text-dimmed">
      <CioSpinner size={12} class="animate-spin" />
      Loading older commits
    </div>
  {:else if !hasMore}
    <p class="py-4 text-center text-[0.5625rem] text-dimmed">Start of history</p>
  {/if}
{/if}
