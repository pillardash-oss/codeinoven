<script lang="ts">
  import {
    GitCommit as GitCommitIcon,
    ArrowDownToLine,
    ArrowUpFromLine,
    Loader2
  } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { GitCommitInfo, GitRemoteUpdate } from '$shared/types'
  import { relativeTime } from '$lib/format/relative-time'
  import { absoluteTime } from './git-status-panel-format'
  import {
    GRAPH_LANE_WIDTH,
    GRAPH_MAX_LANES,
    GRAPH_ROW_HEIGHT,
    assignGraphLanes,
    graphLaneColor,
    graphLaneX,
    graphRemotePlacement,
    graphRowEdges
  } from '$lib/git-graph'

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
   * True when no movement the upstream still holds lands on the unpushed
   * boundary, so the plain "Pushed to <upstream>" line still has to be drawn.
   * That is the case when the reflog is gone past git's expiry, or when the
   * remote was never fetched from this clone, and the split between pushed and
   * unpushed is still real.
   */
  const needsPlainBoundary = $derived(
    unpushedCount > 0 && unpushedCount < rows.length && !placement.boundaries.has(unpushedCount)
  )

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
        <ArrowUpFromLine size={10} class="shrink-0" aria-hidden="true" />
      {:else}
        <ArrowDownToLine size={10} class="shrink-0" aria-hidden="true" />
      {/if}
      {direction}
      {ref}{at === null ? '' : ` · ${relativeTime(at)}`}
    </span>
    <span class="h-px flex-1 bg-border"></span>
  </div>
{/snippet}

{#if loading}
  <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
    <Loader2 size={14} class="animate-spin" />
    Loading history
  </div>
{:else if rows.length === 0}
  <div class="flex flex-col items-center justify-center py-12 text-center">
    <GitCommitIcon size={22} class="mx-auto mb-2 text-dimmed" />
    <p class="text-xs font-medium text-muted">No commits yet</p>
    <p class="mt-1 text-[0.625rem] text-dimmed">Make your first commit to see history.</p>
  </div>
{:else}
  {#if lanesClipped}
    <p class="px-3 pb-1 pt-2 text-[0.5625rem] text-dimmed">
      Showing the first {GRAPH_MAX_LANES} lanes of history
    </p>
  {/if}

  {#each rows as row, index (row.commit.hash)}
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
        : pushed
          ? `Pushed to ${upstream ?? 'the remote'}`
          : `Not pushed to ${upstream ?? 'the remote'} yet`}
    {@const batchStart = placement.boundaries.get(index) ?? null}
    {#if batchStart}
      {@render batchBoundary(batchStart)}
    {:else if needsPlainBoundary && index === unpushedCount}
      {@render batchBoundary(null)}
    {/if}
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
            {#if !pushed}
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
            <circle
              cx={graphLaneX(row.lane)}
              cy={GRAPH_ROW_HEIGHT / 2}
              r="3"
              fill={pushed ? graphLaneColor(row.lane) : 'var(--color-warning)'}
              stroke="var(--color-app)"
              stroke-width="1.5"
            />
          </svg>
          <button
            type="button"
            class={[
              'flex min-w-0 flex-1 items-center gap-2 px-2 text-left',
              pushed ? 'text-foreground' : 'text-muted'
            ]}
            style={`height: ${GRAPH_ROW_HEIGHT}px`}
            title={`View ${row.commit.shortHash}: ${subject}. ${syncLabel}`}
            aria-label={`View commit ${row.commit.shortHash}: ${subject}. ${syncLabel}`}
            onclick={() => onSelectCommit(row.commit)}
          >
            <span class="min-w-0 flex-1 truncate text-[0.6875rem] leading-snug">
              {subject}
            </span>
            {#if rewrittenBy !== null}
              <!-- Amber like the unpushed run it sits in, because the commit is
                   not on the remote now; the badge is what says it was there
                   once, and the row's tooltip names the movement and its time. -->
              <span
                class="shrink-0 rounded-sm bg-warning/10 px-1 py-px text-[0.5rem] font-medium text-warning"
              >
                rewritten
              </span>
            {/if}
            {#each row.commit.refs as ref (ref.head ? `head:${ref.name}` : `${ref.kind}:${ref.name}`)}
              <span
                class={[
                  'shrink-0 rounded-sm px-1 py-px text-[0.5rem] font-medium',
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
            <span class="shrink-0 font-mono text-[0.5625rem] text-dimmed">
              {row.commit.shortHash}
            </span>
            <span class="shrink-0 text-[0.5625rem] text-dimmed">
              {relativeTime(row.commit.date)}
            </span>
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          {@render menu({ commit: row.commit, isHead: index === 0 })}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  {/each}

  {#if loadingMore}
    <div class="flex items-center justify-center gap-2 py-4 text-[0.625rem] text-dimmed">
      <Loader2 size={12} class="animate-spin" />
      Loading older commits
    </div>
  {:else if !hasMore}
    <p class="py-4 text-center text-[0.5625rem] text-dimmed">Start of history</p>
  {/if}
{/if}
