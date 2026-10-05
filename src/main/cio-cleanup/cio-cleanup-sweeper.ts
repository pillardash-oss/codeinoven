import { lstat, readdir, rm } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'
import type {
  CioCleanupExclusion,
  CioCleanupRemovalRecord,
  CioCleanupTarget
} from '../../lib/types/cio-cleanup'
import { isCioCleanupExcluded } from '../../lib/cio-cleanup'

/**
 * How many entries one pass examines before it hands the event loop back. Every
 * filesystem call here is async, but a sweep can still walk tens of thousands of
 * entries in one run, so the loop yields between batches to keep the main
 * process responsive while a cleanup is in flight.
 */
const YIELD_EVERY_ENTRIES = 40

/**
 * Deepest directory chain a sweep walks. Scratch trees are shallow; a deeper
 * one is a runaway agent's output, and descending into it would cost more than
 * the space it reclaims.
 */
const MAX_DEPTH = 32

/** Most removal records one pass keeps. Counts stay exact; the log is bounded. */
const MAX_REMOVAL_RECORDS = 200

/** How one pass is driven, so a manual run can report and be cancelled. */
export interface CioCleanupSweepControl {
  isCancelled(): boolean
  /** Called after each batch with the number of entries examined so far. */
  onScanned?(scanned: number): void
  /** Hands the event loop back; overridable so tests need no timers. */
  yieldToEventLoop?(): Promise<void>
}

export interface CioCleanupSweepResult {
  removed: CioCleanupRemovalRecord[]
  /** Files and folders removed, entries included. */
  entriesRemoved: number
  bytesRemoved: number
  /** Entries examined (compared against the cutoff), removed or not. */
  scanned: number
  cancelled: boolean
}

interface SweepContext {
  target: CioCleanupTarget
  cutoff: number
  exclusions: readonly CioCleanupExclusion[]
  control: CioCleanupSweepControl
  scanned: number
  cancelled: boolean
}

/** Whether any mount that names this folder protects the path. */
function isExcluded(context: SweepContext, relativePath: string): boolean {
  return context.target.mounts.some((mount) =>
    isCioCleanupExcluded(context.exclusions, mount, relativePath)
  )
}

/** What one directory still holds after the pass, plus what it removed. */
interface PruneOutcome {
  /** Entries that remain in this directory. */
  survivors: number
  /** Entries that could not be read, and are therefore kept. */
  unknown: number
  /**
   * Whether the walk of this directory was cut short by a cancellation. A
   * half-walked directory is never removed: its unvisited entries were never
   * judged, so removing the tree would take fresh content with the stale.
   */
  cancelled: boolean
  records: CioCleanupRemovalRecord[]
  entries: number
  bytes: number
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Remove the stale content of one scratch folder.
 *
 * The rule is deliberately conservative and self-explaining: an entry is
 * removed only when its own last modification is older than the cutoff, and a
 * directory is removed only once everything inside it is gone. So a folder that
 * was touched yesterday survives whole, and one abandoned a year ago disappears
 * in one pass, whatever it contains.
 *
 * The scratch folder itself is never removed, a `.git` inside it is never
 * walked or removed, and a symbolic link is removed as a link because `lstat`
 * never follows one. Every removal is checked against the folder first, so a
 * symlinked entry can never point the sweep somewhere else.
 */
export async function sweepCioScratchRoot(options: {
  scratchRoot: string
  target: CioCleanupTarget
  cutoff: number
  exclusions: readonly CioCleanupExclusion[]
  control: CioCleanupSweepControl
}): Promise<CioCleanupSweepResult> {
  const context: SweepContext = {
    target: options.target,
    cutoff: options.cutoff,
    exclusions: options.exclusions,
    control: options.control,
    scanned: 0,
    cancelled: false
  }

  let rootInfo: Stats
  try {
    rootInfo = await lstat(options.scratchRoot)
  } catch {
    // The folder does not exist (or cannot be read): there is nothing to sweep.
    return { removed: [], entriesRemoved: 0, bytesRemoved: 0, scanned: 0, cancelled: false }
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return { removed: [], entriesRemoved: 0, bytesRemoved: 0, scanned: 0, cancelled: false }
  }

  const outcome = await pruneDirectory(context, options.scratchRoot, '', 0)

  return {
    removed: trimRecords(outcome.records),
    entriesRemoved: outcome.entries,
    bytesRemoved: outcome.bytes,
    scanned: context.scanned,
    cancelled: context.cancelled
  }
}

async function pruneDirectory(
  context: SweepContext,
  dirAbs: string,
  dirRel: string,
  depth: number
): Promise<PruneOutcome> {
  const outcome: PruneOutcome = {
    survivors: 0,
    unknown: 0,
    cancelled: false,
    records: [],
    entries: 0,
    bytes: 0
  }

  let children: Dirent[]
  try {
    children = await readdir(dirAbs, { withFileTypes: true })
  } catch {
    outcome.unknown += 1
    return outcome
  }

  for (const child of children) {
    if (context.cancelled || context.control.isCancelled()) {
      context.cancelled = true
      outcome.cancelled = true
      return outcome
    }

    const childAbs = join(dirAbs, child.name)
    const childRel = dirRel ? `${dirRel}/${child.name}` : child.name
    context.scanned += 1

    // A nested repository is neither scratch this app wrote nor something a
    // stale-content rule should ever take apart.
    if (child.name === '.git' && child.isDirectory()) {
      outcome.survivors += 1
      continue
    }
    if (isExcluded(context, childRel)) {
      outcome.survivors += 1
      continue
    }

    let info: Stats
    try {
      info = await lstat(childAbs)
    } catch {
      // Vanished under us (another process) or unreadable: keep it, keep counting.
      outcome.unknown += 1
      continue
    }

    const isDirectory = !info.isSymbolicLink() && info.isDirectory()
    if (!isDirectory) {
      if (info.mtimeMs < context.cutoff && (await removeEntry(childAbs, false))) {
        outcome.records.push({
          target: context.target.label,
          path: childRel,
          kind: 'file',
          entries: 1,
          bytes: info.size
        })
        outcome.entries += 1
        outcome.bytes += info.size
      } else {
        outcome.survivors += 1
      }
      await maybeYield(context)
      continue
    }

    if (depth >= MAX_DEPTH) {
      outcome.survivors += 1
      continue
    }

    const inner = await pruneDirectory(context, childAbs, childRel, depth + 1)
    const removable =
      !inner.cancelled &&
      inner.unknown === 0 &&
      inner.survivors === 0 &&
      info.mtimeMs < context.cutoff
    if (removable && (await removeEntry(childAbs, true))) {
      // The whole directory went, so its children's records collapse into one
      // line: the panel reports `.cio/work/old-feature`, not every file in it.
      outcome.records.push({
        target: context.target.label,
        path: childRel,
        kind: 'directory',
        entries: inner.entries + 1,
        bytes: inner.bytes
      })
      outcome.entries += inner.entries + 1
      outcome.bytes += inner.bytes
      continue
    }

    // The directory stays: carry its own removals up so the caller reports them.
    outcome.records.push(...inner.records)
    outcome.entries += inner.entries
    outcome.bytes += inner.bytes
    outcome.survivors += 1
  }

  return outcome
}

/** Remove one entry. A link is removed as a link, never followed. */
async function removeEntry(absolutePath: string, recursive: boolean): Promise<boolean> {
  try {
    await rm(absolutePath, { recursive, force: true, maxRetries: 2 })
    return true
  } catch {
    return false
  }
}

async function maybeYield(context: SweepContext): Promise<void> {
  if (context.scanned % YIELD_EVERY_ENTRIES !== 0) return
  context.control.onScanned?.(context.scanned)
  await (context.control.yieldToEventLoop ?? defaultYield)()
}

function trimRecords(records: CioCleanupRemovalRecord[]): CioCleanupRemovalRecord[] {
  return records.length > MAX_REMOVAL_RECORDS ? records.slice(-MAX_REMOVAL_RECORDS) : records
}
