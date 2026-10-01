/**
 * The Chromium profile behind every persistent browser partition, and how to take
 * one away.
 *
 * A context's own partition is its profile:
 * `persist:codeinoven-browser:<projectId>` becomes one directory under Electron's
 * `Partitions` root, and clearing a session empties that directory without ever
 * removing it. A box's partition is the profile's rather than a context's:
 * `persist:codeinoven-browser:browser-global:box:<boxId>` names the one profile
 * every context that picks that box shares. A project or a box that is deleted
 * therefore leaves its whole profile on disk unless the directory itself goes, and
 * the profile can be gigabytes of cache. The startup sweep also reclaims the
 * per-project box jars an earlier build created, since nothing resolves to them
 * any more. Nothing else knows how a partition name maps to a path, so that
 * mapping, the removal and the sweep that reclaims what an earlier run left behind
 * all live here, which is what keeps the deletion paths and the sweep from
 * disagreeing about which directory is whose.
 */

import { join } from 'node:path'
import { app } from 'electron'
import { ASSISTANT_SPACE_ID, GLOBAL_BROWSER_PROJECT_ID, INBOX_PROJECT_ID } from '../../../lib/types'
import { listDirectories, removeDir } from '../../../lib/utils'
import { Logger } from '../../system/logger'
import type { Database } from '../../database/database'
import { ProjectRepo } from '../../database/repositories/project-repo'
import { instanceRegistry } from '../../system/instance-registry'
import { GlobalBrowserTabsStore } from '../global-browser-tabs-store'
import {
  BROWSER_PARTITION_PREFIX,
  LEGACY_BROWSER_PARTITION,
  boxIdFromPartition,
  partitionBelongsToProject
} from './browser-validation'

/**
 * Profiles one sweep may remove before it leaves the rest for the next launch.
 *
 * A profile can be gigabytes of cache, and reclaiming a backlog must cost a
 * background task rather than a slower launch, so a machine that is recovering
 * from a large backlog reclaims steadily instead of stalling one start.
 */
const MAX_PROFILES_PER_SWEEP = 12

/** One persistent browser profile as it exists on disk. */
export interface BrowserProfileDirectory {
  /** The directory name inside the `Partitions` root, in Chromium's own spelling. */
  name: string
  /** The partition the directory belongs to, `persist:` included. */
  partition: string
  /** Absolute path of the directory. */
  path: string
}

/**
 * The root Electron keeps every persistent partition profile in.
 *
 * Read at call time rather than captured at import: `sessionData` is redirected
 * before `ready` (see `configureElectronDataRoot`), and a path captured earlier
 * would name the directory Electron used before that redirect.
 */
export function browserProfilesRoot(): string {
  return join(app.getPath('sessionData'), 'Partitions')
}

/** Chromium's directory name for one partition: `persist:` dropped, `:` escaped. */
export function browserProfileDirectoryName(partition: string): string {
  return partition.replace(/^persist:/u, '').replaceAll(':', '%3A')
}

/** The partition one directory name stands for, undoing the escaping above. */
export function browserPartitionFromDirectoryName(name: string): string {
  return `persist:${name.replace(/%3a/giu, ':')}`
}

/**
 * Whether a partition is one this app's browser could have created.
 *
 * The sweep removes nothing else: a second process (a development probe) keeps its
 * own partitions in the same root on a shared `userData`, and a name this app
 * never mints is not this app's to remove.
 */
export function isBrowserOwnedPartition(partition: string): boolean {
  return partition === LEGACY_BROWSER_PARTITION || partition.startsWith(BROWSER_PARTITION_PREFIX)
}

/** Every profile Electron currently keeps. */
export async function listBrowserProfiles(): Promise<BrowserProfileDirectory[]> {
  const root = browserProfilesRoot()
  const names = await listDirectories(root)
  return names.map((name) => ({
    name,
    partition: browserPartitionFromDirectoryName(name),
    path: join(root, name)
  }))
}

/** The profiles one project owns: the context's own jar, and nothing else.
 *
 *  A box's jar belongs to the profile rather than to a project, so it is never a
 *  project's to remove: deleting a project must not take a box's cookies away
 *  from the global browser and from every other project that picked it. */
export async function listProjectBrowserProfiles(
  projectId: string
): Promise<BrowserProfileDirectory[]> {
  const profiles = await listBrowserProfiles()
  return profiles.filter((profile) => partitionBelongsToProject(profile.partition, projectId))
}

/** The profiles on disk for one partition.
 *
 *  This is how a jar that no project owns is still removed by the thing that does
 *  own it: a box that was deleted, whose jar is shared by every context. */
export async function listBrowserProfilesForPartition(
  partition: string
): Promise<BrowserProfileDirectory[]> {
  const profiles = await listBrowserProfiles()
  return profiles.filter((profile) => profile.partition === partition)
}

/**
 * Remove the given profiles, one directory at a time.
 *
 * Sequential on purpose: a profile's cache can be gigabytes, and removing several
 * at once would put one filesystem walk per profile on the thread pool while the
 * app is trying to paint. A directory that cannot be removed is reported and left
 * for the next sweep rather than failing the work that asked for the removal.
 */
export async function removeBrowserProfiles(
  profiles: readonly BrowserProfileDirectory[]
): Promise<string[]> {
  const removed: string[] = []
  for (const profile of profiles) {
    try {
      await removeDir(profile.path)
      removed.push(profile.name)
    } catch (error: unknown) {
      Logger.error(`Browser profile "${profile.name}" could not be removed:`, error)
    }
  }
  return removed
}

/**
 * Remove every profile one project owned.
 *
 * Called when the project itself is gone, so nothing can resolve to these
 * partitions again. Erasing a context that is *kept* is a different action: its
 * live session still holds the profile open, and clearing its storage is what
 * empties it (see `BrowserSiteDataService`).
 */
export async function removeProjectBrowserProfiles(projectId: string): Promise<string[]> {
  return removeBrowserProfiles(await listProjectBrowserProfiles(projectId))
}

/**
 * Whether one partition is still named by something that exists.
 *
 * The context's own jar is claimed by its project alone. A box's jar is claimed
 * while its box exists, whichever context made it: boxes belong to the profile,
 * so a project staying or going says nothing about one. A box list that could not
 * be read answers "claimed" rather than guessing: an unreadable file is not
 * evidence that the user's boxed logins are garbage.
 */
function isClaimedPartition(
  partition: string,
  claimedProjectIds: ReadonlySet<string>,
  liveBoxIds: ReadonlySet<string> | null
): boolean {
  const boxId = boxIdFromPartition(partition)
  if (boxId !== null) return liveBoxIds === null || liveBoxIds.has(boxId)
  // Context ids can be prefixes of each other, and a partition carries no marker
  // for where the prefix ends, so a project's own jar is matched whole.
  return claimedProjectIds.has(partition.slice(BROWSER_PARTITION_PREFIX.length))
}

/**
 * Reclaim the profiles no live context owns.
 *
 * A profile is kept while a project row names it and, for a box jar, while its box
 * still exists: `browser-global`, `assistant` and `inbox` are ordinary rows, so
 * they are kept the same way. Everything else was left behind by a project that was
 * deleted before its browser was erased, by a box that was deleted with its data
 * kept, or by the single-profile browser that predates per-project jars, and no
 * code can reach it again.
 *
 * The caller owns the condition this cannot judge for itself: a profile whose
 * owner is missing only proves the profile is unreachable when the owner list was
 * actually read, which is why an empty project list is refused rather than
 * believed.
 */
export async function pruneUnclaimedBrowserProfiles(
  liveProjectIds: readonly string[],
  liveBoxIds: ReadonlySet<string> | null
): Promise<string[]> {
  if (liveProjectIds.length === 0) return []
  // The built-in contexts are rows of their own, but a first run that has not
  // seeded them yet must never cost the user their personal browser profile.
  const claimed = new Set<string>([
    ...liveProjectIds,
    INBOX_PROJECT_ID,
    ASSISTANT_SPACE_ID,
    GLOBAL_BROWSER_PROJECT_ID
  ])
  const unclaimed = (await listBrowserProfiles()).filter(
    (profile) =>
      isBrowserOwnedPartition(profile.partition) &&
      !isClaimedPartition(profile.partition, claimed, liveBoxIds)
  )
  return removeBrowserProfiles(unclaimed.slice(0, MAX_PROFILES_PER_SWEEP))
}

/**
 * The startup sweep: reclaim the browser profiles an earlier run left behind.
 *
 * A sibling instance may be browsing a project this process has not read from the
 * shared database yet, so its live browser is not ours to take away and the sweep
 * declines to run at all. The project list comes from the database worker, because
 * the sweep compares rows against the filesystem and the interactive path must
 * never wait on SQLite for it. The removal itself is the bounded, sequential walk
 * above.
 */
export async function sweepUnclaimedBrowserProfiles(database: Database): Promise<number> {
  if (instanceRegistry.hasOtherLiveInstance()) return 0
  const liveProjectIds = await new ProjectRepo(database).listIdsViaWorker()
  const snapshot = await new GlobalBrowserTabsStore().load()
  const liveBoxIds = snapshot === null ? null : new Set((snapshot.boxes ?? []).map((box) => box.id))
  const removed = await pruneUnclaimedBrowserProfiles(liveProjectIds, liveBoxIds)
  if (removed.length > 0) {
    Logger.info('Reclaimed browser profiles no project owns', { removed })
  }
  return removed.length
}
