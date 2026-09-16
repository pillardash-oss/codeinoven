<script lang="ts">
  import { GitCommit as GitCommitIcon, Loader2 } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { GitCommitInfo } from '$shared/types'
  import { relativeTime } from '$lib/format/relative-time'
  import {
    GRAPH_LANE_WIDTH,
    GRAPH_MAX_LANES,
    GRAPH_ROW_HEIGHT,
    assignGraphLanes,
    graphLaneColor,
    graphLaneX,
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
</script>

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
    {#if unpushedCount > 0 && index === unpushedCount}
      <div class="flex items-center gap-2 px-2 py-1">
        <span class="h-px flex-1 bg-border"></span>
        <span class="shrink-0 text-[0.5625rem] font-medium text-dimmed">
          Pushed to {upstream ?? 'the remote'}
        </span>
        <span class="h-px flex-1 bg-border"></span>
      </div>
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
            <circle
              cx={graphLaneX(row.lane)}
              cy={GRAPH_ROW_HEIGHT / 2}
              r="3"
              fill={graphLaneColor(row.lane)}
              stroke="var(--color-app)"
              stroke-width="1.5"
            />
          </svg>
          <button
            type="button"
            class={[
              'flex min-w-0 flex-1 items-center gap-2 px-2 text-left',
              index < unpushedCount ? 'text-muted' : 'text-foreground'
            ]}
            style={`height: ${GRAPH_ROW_HEIGHT}px`}
            title={`View ${row.commit.shortHash}: ${row.commit.message.split('\n')[0] ?? ''}`}
            aria-label={`View commit ${row.commit.shortHash}: ${row.commit.message.split('\n')[0] ?? ''}`}
            onclick={() => onSelectCommit(row.commit)}
          >
            <span class="min-w-0 flex-1 truncate text-[0.6875rem] leading-snug">
              {row.commit.message.split('\n')[0]}
            </span>
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
