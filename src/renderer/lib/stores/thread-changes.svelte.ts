import { invoke, subscribe } from '$lib/ipc.svelte'
import { LatestRequestGuard } from '$lib/refresh-guard'
import { diffDetails } from '$lib/components/files/file-diff'
import { appQuitState } from './app-quit.svelte'
import type { AgentEvent, TurnCheckpointFileDiff, TurnCheckpointSummary } from '$shared/types'

/** Line totals the Changes indicator shows for a change set. */
export interface ChangeLineTotals {
  additions: number
  deletions: number
  /** True when at least one file's lines could not be counted in full. */
  partial: boolean
}

/** The live line-count pass is bounded to this many files; more than this is
 *  reported as a partial count instead of scanning the whole change set on a
 *  hover. */
const MAX_LIVE_STAT_FILES = 24

/**
 * The change set the Changes rail icon summarizes for the conversation on
 * screen.
 *
 * The Changes panel owns the full history, but it is only mounted while it is
 * open. This store keeps the one summary the rail needs whether or not the
 * panel is mounted: the running turn's live edits while a turn runs, and the
 * newest finished turn's edits otherwise. It is event-driven (the engine fires
 * `checkpoint.liveUpdated` per scan), so the rail updates on the same beat as
 * the panel without a second poll on the hot path.
 *
 * Line counts are not part of a live summary: main computes them only when the
 * turn settles. So the live totals are counted on demand, when the flyout is
 * first shown, from the same bounded live diffs the panel reads. A finished
 * turn's totals come straight from its stored summary.
 */
class ThreadChangesState {
  /** The running turn's live change summary, or null. */
  live = $state<TurnCheckpointSummary | null>(null)
  /** The newest finished turn's change summary, or null. */
  latest = $state<TurnCheckpointSummary | null>(null)
  /** Line totals counted on demand for the live summary, or null until then. */
  liveTotals = $state<ChangeLineTotals | null>(null)

  private projectId: string | null = null
  private threadId: string | null = null
  private started = false
  private unsubscribe: (() => void) | null = null
  private readonly summaryGuard = new LatestRequestGuard()
  private readonly totalsGuard = new LatestRequestGuard()
  private generation = 0
  private liveTotalsKey: string | null = null

  /** The change set the indicator summarizes: the live turn while one runs,
   *  otherwise the newest recorded change set. */
  get current(): TurnCheckpointSummary | null {
    return this.live ?? this.latest
  }

  /** Whether the summarized change set is the running turn's. */
  get working(): boolean {
    return this.live !== null
  }

  /** How many files the current change set touched. */
  get fileCount(): number {
    return this.current?.changes.length ?? 0
  }

  /** Line totals for the current change set, or null while none is known. */
  get totals(): ChangeLineTotals | null {
    const current = this.current
    if (!current) return null
    if (current.status !== 'active') return this.storedTotals(current)
    return this.liveTotals
  }

  /** Point the indicator at a conversation. Idempotent for the same target. */
  track(projectId: string, threadId: string): void {
    if (this.projectId === projectId && this.threadId === threadId) return
    this.ensureStarted()
    this.projectId = projectId
    this.threadId = threadId
    this.generation += 1
    this.live = null
    this.latest = null
    this.liveTotals = null
    this.liveTotalsKey = null
    void this.refresh()
  }

  /** Drop the target (no conversation on screen). */
  untrack(): void {
    if (this.projectId === null && this.threadId === null) return
    this.projectId = null
    this.threadId = null
    this.generation += 1
    this.live = null
    this.latest = null
    this.liveTotals = null
    this.liveTotalsKey = null
  }

  /**
   * Count the live turn's line totals, once per change-set shape.
   *
   * Called by the flyout when it opens, so the bounded live-diff fan-out never
   * runs in the background. A no-op for a finished change set, whose totals are
   * already stored.
   */
  async ensureLiveTotals(): Promise<void> {
    const live = this.live
    if (!live || live.changes.length === 0) return
    const key = liveTotalsKeyFor(live)
    if (this.liveTotalsKey === key && this.liveTotals) return
    const projectId = this.projectId
    const threadId = this.threadId
    if (!projectId || !threadId || appQuitState.quitting) return
    this.liveTotalsKey = key
    const request = this.totalsGuard.begin()
    const generation = this.generation
    const countable = live.changes.filter((change) => !change.binary)
    const sample = countable.slice(0, MAX_LIVE_STAT_FILES)
    const results = await Promise.allSettled(
      sample.map((change) =>
        invoke('checkpoint:liveDiff', projectId, threadId, live.id, change.path)
      )
    )
    if (generation !== this.generation || !this.totalsGuard.isCurrent(request)) return
    let additions = 0
    let deletions = 0
    let partial = countable.length > sample.length || live.changes.length !== countable.length
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        partial = true
        continue
      }
      const diff: TurnCheckpointFileDiff = result.value
      if (diff.binary) {
        partial = true
        continue
      }
      if (diff.truncated) partial = true
      const details = diffDetails(diff.before, diff.after)
      additions += details.additions
      deletions += details.deletions
    }
    this.liveTotals = { additions, deletions, partial }
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = subscribe('agent:event', (...args: unknown[]) => {
      this.handleEvent(args[0])
    })
  }

  private handleEvent(raw: unknown): void {
    const event = raw as AgentEvent | undefined
    if (!event || !('projectId' in event) || !('threadId' in event)) return
    if (event.projectId !== this.projectId || event.threadId !== this.threadId) return
    if (event.type === 'checkpoint.liveUpdated') {
      void this.refreshLive()
    } else if (event.type === 'checkpoint.updated') {
      void this.refresh()
    }
  }

  private storedTotals(summary: TurnCheckpointSummary): ChangeLineTotals {
    let additions = 0
    let deletions = 0
    let partial = false
    for (const change of summary.changes) {
      additions += change.additions ?? 0
      deletions += change.deletions ?? 0
      if (change.lineCountsTruncated) partial = true
    }
    return { additions, deletions, partial }
  }

  /** Read the current change set: the live turn, and the newest finished turn. */
  private async refresh(): Promise<void> {
    if (appQuitState.quitting) return
    const projectId = this.projectId
    const threadId = this.threadId
    if (!projectId || !threadId) return
    const request = this.summaryGuard.begin()
    const generation = this.generation
    try {
      const live = await invoke('checkpoint:activeSummary', projectId, threadId)
      if (generation !== this.generation || !this.summaryGuard.isCurrent(request)) return
      this.live = live
      this.liveTotals = null
      this.liveTotalsKey = null
      // A running turn already carries the freshest record; the finished history
      // is unchanged until it settles.
      if (live) return
      const latest = await invoke('checkpoint:latestSummary', projectId, threadId)
      if (generation !== this.generation || !this.summaryGuard.isCurrent(request)) return
      this.latest = latest && latest.status !== 'rolled_back' ? latest : null
    } catch {
      // The indicator is supplementary; the Changes panel keeps the record.
    }
  }

  /** Cheap live refresh on a scan event: re-read only the active summary. */
  private async refreshLive(): Promise<void> {
    if (appQuitState.quitting) return
    const projectId = this.projectId
    const threadId = this.threadId
    if (!projectId || !threadId) return
    const request = this.summaryGuard.begin()
    const generation = this.generation
    try {
      const live = await invoke('checkpoint:activeSummary', projectId, threadId)
      if (generation !== this.generation || !this.summaryGuard.isCurrent(request)) return
      if (!live) return
      this.live = live
      this.liveTotals = null
      this.liveTotalsKey = null
    } catch {
      // Supplementary.
    }
  }
}

/** A change-set shape signature: two summaries with the same paths and kinds
 *  have the same line totals, so the on-demand count is reused. */
function liveTotalsKeyFor(summary: TurnCheckpointSummary): string {
  const shape = summary.changes.map((change) => `${change.kind}:${change.path}`).join('|')
  return `${summary.id}:${shape}`
}

export const threadChangesState = new ThreadChangesState()
