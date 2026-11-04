import type {
  DesignHistoryState,
  DesignPageHistoryState,
  DesignRevisionCause,
  DesignRevisionSummary
} from '../../lib/ipc/design'

/**
 * The design capability's `history` and `restore` operations.
 *
 * The board's timeline was the only way back through a design: it lives in the
 * renderer, so an agent that broke a screen after a checkpoint had no way to
 * rewind, and the user had to do it by hand. These two operations open the same
 * timeline and the same durable restore the board's Undo uses, in the bounded
 * shape an agent can read: the newest points, which of them the folder sits at,
 * and a reference that names one of them.
 *
 * Reading is not a dry run. `DesignHistoryService.state` captures whatever is on
 * disk before it answers, so the state an agent is about to overwrite is itself a
 * revision by the time the restore runs, which is what makes a rewind undoable.
 */

/** Most points of a folder's timeline returned in one read, newest last. */
export const HISTORY_CAPABILITY_PAGE = 40

/** Paths named per point, so one sprawling revision cannot flood the answer. */
const MAX_CHANGED_PATHS = 40

/** One point in a design folder's history, as an agent reads it. */
export interface DesignHistoryPoint {
  /** Position in the folder's timeline, oldest first, starting at 1. */
  revision: number
  revisionId: string
  cause: DesignRevisionCause
  /** Named agent step, when the point was checkpointed under a label. */
  label?: string
  /** Screen whose step was checkpointed. */
  entry?: string
  createdAt: number
  changedFiles: number
  changedPaths: string[]
  /** Whether the folder on disk sits at this point. */
  current: boolean
}

/** One point on a single page's own line through the folder's history. */
export interface DesignHistoryPagePoint {
  revision: number
  revisionId: string
  label?: string
  createdAt: number
  /** False when the page did not exist at this point, so restoring removes it. */
  present: boolean
  current: boolean
}

/** One page's line, when the caller asked about a page rather than the folder. */
export interface DesignPageHistoryCapability {
  path: string
  /** Position on the folder's timeline the page currently matches, or null. */
  currentRevision: number | null
  /** Whether the page holds content the timeline does not know (a hand edit). */
  modified: boolean
  canUndo: boolean
  canRedo: boolean
  revisions: DesignHistoryPagePoint[]
}

/** What the `history` operation answers. */
export interface DesignHistoryCapabilityResult {
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** Git already tracks this folder, so the app keeps no timeline of its own. */
  gitBacked: boolean
  /** The folder holds a mixture of states, because a page was restored alone. */
  modified: boolean
  /** Position the folder sits at, or null when it has no history yet. */
  currentRevision: number | null
  totalRevisions: number
  /** Older points not included in this answer. */
  omittedOlderRevisions: number
  /** Points oldest first, newest last. */
  revisions: DesignHistoryPoint[]
  page?: DesignPageHistoryCapability
  /** How to rewind, or why there is nothing to rewind to. */
  note: string
}

/** What the `restore` operation answers: the rewind and the timeline afterwards. */
export interface DesignRestoreCapabilityResult {
  directory: string
  restored: { revision: number; revisionId: string; page?: string }
  history: DesignHistoryCapabilityResult
}

function pointOf(revision: DesignRevisionSummary, cursorId: string | null): DesignHistoryPoint {
  const point: DesignHistoryPoint = {
    revision: revision.sequence,
    revisionId: revision.id,
    cause: revision.cause,
    createdAt: revision.createdAt,
    changedFiles: revision.changedFiles,
    changedPaths: revision.changedPaths.slice(0, MAX_CHANGED_PATHS),
    current: revision.id === cursorId
  }
  if (revision.label) point.label = revision.label
  if (revision.checkpointEntry) point.entry = revision.checkpointEntry
  return point
}

function pagePointOf(page: DesignPageHistoryState): DesignPageHistoryCapability {
  return {
    path: page.path,
    currentRevision:
      page.cursorIndex >= 0 ? (page.revisions[page.cursorIndex]?.sequence ?? null) : null,
    modified: page.modified,
    canUndo: page.canUndo,
    canRedo: page.canRedo,
    revisions: page.revisions.map((revision) => ({
      revision: revision.sequence,
      revisionId: revision.revisionId,
      ...(revision.label ? { label: revision.label } : {}),
      createdAt: revision.createdAt,
      present: revision.present,
      current: page.revisions[page.cursorIndex]?.revisionId === revision.revisionId
    }))
  }
}

function noteFor(state: DesignHistoryState, page?: DesignPageHistoryState): string {
  if (state.gitBacked) {
    return 'Git already tracks this folder, so the app keeps no timeline of its own. Read the folder history with Git and rewind with Git, never with this operation.'
  }
  if (state.revisions.length === 0) {
    return 'This folder has no history yet. A checkpoint, or any read of the timeline, is what makes the current state a point to return to.'
  }
  const current =
    state.cursorIndex >= 0 ? `The folder sits at revision ${state.cursorIndex + 1}.` : ''
  const pageNote = page
    ? ' Restoring with page rewrites only that page, so every other screen stays where it is.'
    : ''
  return `${[current, `Rewind with restore, passing the revision number or the revisionId you want back. It records the current state first, so the rewind is itself undoable.${pageNote}`].filter(Boolean).join(' ')}`
}

/** Bound a folder's timeline to the newest page an agent reads in one call. */
export function summarizeDesignHistory(
  state: DesignHistoryState,
  page?: DesignPageHistoryState
): DesignHistoryCapabilityResult {
  const points = state.revisions.map((revision) => pointOf(revision, state.cursorId))
  const kept = points.slice(-HISTORY_CAPABILITY_PAGE)
  const result: DesignHistoryCapabilityResult = {
    directory: state.directory,
    gitBacked: state.gitBacked,
    modified: state.modified,
    currentRevision:
      state.cursorIndex >= 0 ? (state.revisions[state.cursorIndex]?.sequence ?? null) : null,
    totalRevisions: points.length,
    omittedOlderRevisions: points.length - kept.length,
    revisions: kept,
    note: noteFor(state, page)
  }
  if (page) result.page = pagePointOf(page)
  return result
}

/**
 * The revision a caller named, by id or by its position in the timeline.
 *
 * Position is the number the history answer and the board both show, so an agent
 * that said "revision 12" from its own read is understood here rather than being
 * asked for an opaque id it never saw.
 */
export function resolveDesignRevisionId(
  revisions: readonly DesignRevisionSummary[],
  reference: unknown
): string | null {
  if (typeof reference === 'number' && Number.isFinite(reference)) {
    return revisions.find((revision) => revision.sequence === Math.trunc(reference))?.id ?? null
  }
  if (typeof reference !== 'string') return null
  const needle = reference.trim()
  if (!needle) return null
  const byId = revisions.find((revision) => revision.id === needle)
  if (byId) return byId.id
  if (!/^\d+$/u.test(needle)) return null
  const sequence = Number(needle)
  return revisions.find((revision) => revision.sequence === sequence)?.id ?? null
}
