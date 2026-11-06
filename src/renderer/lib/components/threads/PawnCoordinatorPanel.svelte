<script lang="ts">
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import {
    THREAD_GROUP_COLORS,
    THREAD_GROUP_ICONS
  } from '$lib/components/threads/thread-group-presentation'
  import { groupThreadsByStatus } from '$lib/components/workspace/workspace-thread-helpers'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { pawnAgentsState } from '$lib/stores/pawn-agents.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadGroupingState } from '$lib/stores/thread-grouping.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import {
    subagentIsRunning,
    subagentModelLabel,
    subagentStatusLabel,
    subagentTaskDetail,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import SubagentStatusIcon from '$lib/components/threads/SubagentStatusIcon.svelte'
  import type { PawnCoordinatorPanelProps, Thread } from '$shared/types'
  import type { AgentSubagentActivity } from '$shared/types'

  /**
   * The spawn board: every worker this thread delegated work to.
   *
   * Two shapes are delegated, and the board lists both so the user can follow
   * whatever an agent started without knowing which shape it chose. A pawn is a
   * real thread of its own, so it renders exactly as it does in the Threads view.
   * A nested sub-agent has no thread; its rows are the `subagent` parts of this
   * thread's own transcript, which the renderer already holds and updates live,
   * so listing them costs no extra read and needs no second source of truth.
   *
   * Pawn threads never appear in the thread list, and a nested worker has no row
   * anywhere at all, so without this board the work an agent delegated is only
   * reachable from the card in the turn that spawned it.
   */
  let { projectId, threadId }: PawnCoordinatorPanelProps = $props()

  let threads = $derived(pawnAgentsState.workersOf(threadId))
  let runningPawns = $derived(pawnAgentsState.runningCount(threadId))
  let selectedThreadId = $derived(workspaceState.selectedThread?.id ?? null)

  type NestedWorker = { partId: string; activity: AgentSubagentActivity }

  /**
   * The nested sub-agents this thread spawned, newest state per worker.
   *
   * The transcript is walked in order and the last part for a child session
   * wins, because a streaming worker rewrites the same part as its status moves
   * from running to completed. Pawn parts are skipped: the pawn is a thread and
   * already listed above, so folding it in twice would double its row.
   */
  let nestedWorkers = $derived.by((): NestedWorker[] => {
    const workers: NestedWorker[] = []
    for (const message of threadMessages.messages(projectId, threadId)) {
      for (const part of message.parts) {
        if (part.type !== 'subagent') continue
        if (part.activity.pawn === true) continue
        const key = part.activity.childSessionId ?? part.id
        const next: NestedWorker = { partId: part.id, activity: part.activity }
        const index = workers.findIndex(
          (worker) => (worker.activity.childSessionId ?? worker.partId) === key
        )
        if (index >= 0) workers[index] = next
        else workers.push(next)
      }
    }
    workers.sort((left, right) => {
      const leftStart = left.activity.time?.start ?? 0
      const rightStart = right.activity.time?.start ?? 0
      return rightStart - leftStart
    })
    return workers
  })

  let runningNested = $derived(nestedWorkers.filter((worker) => subagentIsRunning(worker.activity)))

  // One clock for the whole list: it ticks only while a nested worker is live, so
  // a finished or restored board shows frozen durations instead of numbers that
  // grow on every render.
  const listClock = new ElapsedTimer()
  $effect(() => {
    if (runningNested.length > 0) listClock.start()
    else {
      listClock.stop()
      listClock.snapshot()
    }
    return () => listClock.stop()
  })

  function workerDuration(worker: NestedWorker): string {
    const seconds = listClock.seconds(worker.activity.time?.start, worker.activity.time?.end)
    return seconds > 0 ? formatDurationSeconds(seconds) : ''
  }

  let running = $derived(runningPawns + runningNested.length)
  let hasAnyWorker = $derived(threads.length > 0 || nestedWorkers.length > 0)
  /** The Threads view's own status grouping, in the user's configured order. */
  let groups = $derived(
    groupThreadsByStatus(threads).filter(
      (group) => group.threads.length > 0 && threadGroupingState.isVisible(group.label)
    )
  )

  /** A pawn runs in its spawner's project, and carries that project's icon. */
  function projectIcon(thread: Thread): string | null {
    return scopeState.projects.find((project) => project.id === thread.projectId)?.iconUrl ?? null
  }

  /** A pawn opens where it lives: its own thread, which the user can then read. */
  function openPawn(thread: Thread): void {
    void openThreadById(thread.projectId, thread.id)
  }

  /** A nested sub-agent opens as a transcript tab under this thread. */
  function openNested(worker: NestedWorker): void {
    contextSidebarState.openSubagent(projectId, threadId, worker.partId, worker.activity)
  }
</script>

<!-- Docked into the context sidebar: the sidebar owns the width, the visibility
     and the tab chrome, so this panel is just a column that fills what it is
     given. -->
<div class="flex h-full min-h-0 flex-col" role="region" aria-label="Spawned agents">
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex min-w-0 items-center gap-2 text-foreground">
      <CioSubagent size={15} class="shrink-0" />
      <h2 class="text-xs font-semibold uppercase tracking-wide">Spawned agents</h2>
      {#if running > 0}
        <span class="ml-auto shrink-0 text-[0.625rem] font-medium text-thread-working">
          {running} running
        </span>
      {/if}
    </div>
    <p class="mt-2 text-xs leading-relaxed text-muted">
      The work this thread delegated. A pawn runs on a thread of its own; a sub-agent runs inside
      this one. Neither commits, and opening either shows the work it did.
    </p>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto pt-2">
    {#if !hasAnyWorker}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <CioSubagent size={22} class="text-dimmed" />
        <p class="text-xs font-medium text-foreground">Nothing delegated yet</p>
        <p class="max-w-[32ch] text-[0.625rem] leading-relaxed text-muted">
          When this thread hands work to an agent, that agent is listed here with its status, so you
          can watch it run and open it without hunting for the turn that spawned it.
        </p>
      </div>
    {:else}
      {#if nestedWorkers.length > 0}
        <section class="px-2 pb-2">
          <h3
            class="flex items-center gap-2 px-2 py-1 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase"
          >
            Sub-agents
            <span class="text-dimmed">{nestedWorkers.length}</span>
          </h3>
          <div class="space-y-px" role="list">
            {#each nestedWorkers as worker (worker.activity.childSessionId ?? worker.partId)}
              {@const detail = subagentTaskDetail(worker.activity)}
              {@const model = subagentModelLabel(worker.activity, true)}
              <div role="listitem">
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-2 border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-dimmed/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-border"
                  title="Open the transcript of the {subagentTaskLabel(worker.activity)} sub-agent"
                  aria-label="Open the transcript of the {subagentTaskLabel(
                    worker.activity
                  )} sub-agent"
                  onclick={() => openNested(worker)}
                >
                  <SubagentStatusIcon status={worker.activity.status} />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs font-medium text-foreground">
                      {subagentTaskLabel(worker.activity)}
                    </span>
                    {#if detail}
                      <span class="block truncate text-[0.625rem] text-muted">{detail}</span>
                    {/if}
                  </span>
                  <span class="shrink-0 text-right text-[0.625rem] leading-tight text-muted">
                    <span class="block">{subagentStatusLabel(worker.activity.status)}</span>
                    <span class="block">
                      {#if subagentIsRunning(worker.activity)}
                        {workerDuration(worker)}
                      {:else}
                        {workerDuration(worker) || (model ?? '')}
                      {/if}
                    </span>
                  </span>
                </button>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if threads.length > 0}
        {#if groups.length === 0}
          <div class="px-4 py-6 text-center">
            <p class="text-[0.625rem] leading-relaxed text-muted">
              The status groups these pawns belong to are hidden in the Threads view. Show them
              there to see the pawns here.
            </p>
          </div>
        {:else}
          <div class="px-2">
            {#each groups as group (group.label)}
              {@const folded = threadGroupingState.isFolded(group.label)}
              <section>
                <div class="sticky -top-2 z-10 bg-surface">
                  <PinnedSection
                    sectionKey="threads"
                    label={group.label}
                    threads={group.threads}
                    headerOnly
                    icon={THREAD_GROUP_ICONS[group.label]}
                    accent={THREAD_GROUP_COLORS[group.label]}
                    {folded}
                    onToggleFold={() => threadGroupingState.toggleFold(group.label)}
                    activeThreadId={selectedThreadId}
                    onOpen={openPawn}
                  />
                </div>
                {#if !folded}
                  <div class="space-y-px pb-5" role="list">
                    {#each group.threads as thread (thread.id)}
                      <ThreadRow
                        {thread}
                        detailed
                        projectIconUrl={projectIcon(thread)}
                        selected={selectedThreadId === thread.id}
                        showChangeScope={false}
                        onOpen={openPawn}
                      />
                    {/each}
                  </div>
                {/if}
              </section>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</div>
