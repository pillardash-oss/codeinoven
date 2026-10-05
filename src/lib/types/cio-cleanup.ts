/**
 * CIO Cleanup   the shared vocabulary of the daily sweep of stale scratch.
 *
 * Every workspace CodeInOven can stage scratch in owns one `.cio` folder: a
 * project checkout, a managed scope worktree, a standalone chat's workspace, an
 * assistant routine's workspace, and a browser tab's workspace. All of them are
 * swept by the same rules, so the shapes that cross the IPC boundary live here
 * rather than in the main-process service that owns the work.
 */

/** Which workspace a scratch folder belongs to. */
export type CioCleanupOwnerKind = 'project' | 'chat' | 'assistant' | 'browser' | 'legacy'

/**
 * One `.cio` folder the sweep knows by name.
 *
 * A workspace's scratch folder is not one thing: `tmp`, `work`, `specs`, and
 * `git` hold transient material, while `designs`, `videos`, and `utilities` hold
 * deliverables and installed content. The settings page lists these ids and the
 * sweep reads them, so one vocabulary answers both what a row says and which
 * folders a run must keep.
 */
export type CioCleanupCategoryId =
  'scratch' | 'work' | 'specs' | 'git' | 'designs' | 'videos' | 'utilities'

/** Every category, in the order the settings page lists them. */
export const CIO_CLEANUP_CATEGORY_IDS: readonly CioCleanupCategoryId[] = [
  'scratch',
  'work',
  'specs',
  'git',
  'designs',
  'videos',
  'utilities'
]

/**
 * What a fresh install excludes: the folders holding authored work and installed
 * content rather than scratch. The four scratch folders are swept, because that
 * is the feature's whole point; these three are kept until the user says
 * otherwise.
 */
export const DEFAULT_CIO_CLEANUP_EXCLUDED_CATEGORIES: readonly CioCleanupCategoryId[] = [
  'designs',
  'videos',
  'utilities'
]

/** Whether a value is one of the categories the sweep knows. */
export function isCioCleanupCategoryId(value: unknown): value is CioCleanupCategoryId {
  return (
    typeof value === 'string' && (CIO_CLEANUP_CATEGORY_IDS as readonly string[]).includes(value)
  )
}

/**
 * The stored exclusion list as the sweep reads it.
 *
 * A missing value is a config written before the list existed and means the
 * shipped defaults; anything unusable is dropped rather than rejected, so a
 * hand-edited file still starts. The result keeps the canonical order and has no
 * duplicates, so two spellings of one choice cannot reach the settings page.
 */
export function normalizeCioCleanupExcludedCategories(value: unknown): CioCleanupCategoryId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CIO_CLEANUP_EXCLUDED_CATEGORIES]
  const chosen = new Set(value.filter(isCioCleanupCategoryId))
  return CIO_CLEANUP_CATEGORY_IDS.filter((id) => chosen.has(id))
}

/**
 * Identifies one workspace mount, using the same triple the file tree uses to
 * resolve a root: a project, its scope bucket, and (for a conversation's own
 * workspace) the conversation. Exclusions are keyed by it because a sweep
 * resolves roots the same way, so no absolute path has to be stored.
 */
export interface CioCleanupMount {
  projectId: string
  scopeBucketId: string
  /** Set when the mount is a conversation's workspace (chat, assistant task, browser tab chat). */
  threadId?: string
}

/** One excluded path inside a scratch folder, relative to `.cio`. */
export interface CioCleanupExclusion extends CioCleanupMount {
  /** Forward-slashed path inside `.cio`; the exclusion also covers its children. */
  path: string
  createdAt: number
}

/** One scratch folder a run may sweep. */
export interface CioCleanupTarget {
  /** Stable identity of the folder, used for dedup and for log lines. */
  id: string
  kind: CioCleanupOwnerKind
  /** Human label of the workspace, e.g. `CodeInOven · Default`. */
  label: string
  /**
   * Every mount key that names this folder. A routine's workspace is shared by
   * all of its tasks, so the folder answers to the routine's directory name and
   * to each task's own id; an exclusion set from any of their file trees must
   * therefore protect the one folder they mount.
   */
  mounts: CioCleanupMount[]
  /** Absolute path of the folder that is swept (the `.cio` directory). */
  scratchRoot: string
}

/** One entry a run removed. */
export interface CioCleanupRemovalRecord {
  /** Label of the workspace the entry lived in. */
  target: string
  /** Path relative to the swept folder, forward-slashed. */
  path: string
  kind: 'file' | 'directory'
  /** Files and folders that went with the entry. */
  entries: number
  bytes: number
}

export type CioCleanupPhase = 'preparing' | 'sweeping' | 'completed' | 'cancelled' | 'failed'

/** Who started a run. Only a manual run is surfaced while it works. */
export type CioCleanupOrigin = 'manual' | 'scheduled'

/** One live stage of a cleanup run. */
export interface CioCleanupProgress {
  runId: string
  origin: CioCleanupOrigin
  phase: CioCleanupPhase
  /** Label of the folder being swept right now, or null between folders. */
  currentTarget: string | null
  targetsTotal: number
  targetsDone: number
  entriesRemoved: number
  bytesRemoved: number
  /** Bounded, newest-last record of what the run removed. */
  removed: CioCleanupRemovalRecord[]
  startedAt: number
  finishedAt?: number
  error?: string
}

/** What the last finished run did, kept so the settings page can report it. */
export interface CioCleanupRunSummary {
  runId: string
  origin: CioCleanupOrigin
  phase: 'completed' | 'cancelled' | 'failed'
  startedAt: number
  finishedAt: number
  targetsSwept: number
  entriesRemoved: number
  bytesRemoved: number
  error?: string
}

/** Everything the surfaces need to describe the feature's current state. */
export interface CioCleanupState {
  /** Age after which scratch content is deleted, from the app config. */
  retentionDays: number
  /** Timestamp of the next scheduled run, or null when none is armed. */
  nextRunAt: number | null
  /** True while a run is in flight (manual or scheduled). */
  running: boolean
  /** The last finished run, or null when the feature never ran. */
  lastRun: CioCleanupRunSummary | null
  /** Every exclusion the user set, across all workspaces. */
  exclusions: CioCleanupExclusion[]
}

/** Exclude or include one path inside a workspace's `.cio` folder. */
export interface CioCleanupExclusionToggleInput extends CioCleanupMount {
  /** Workspace-relative path, e.g. `.cio/specs/cio-cleanup`. */
  path: string
}

export interface CioCleanupExclusionToggleResult {
  excluded: boolean
  exclusions: CioCleanupExclusion[]
}
