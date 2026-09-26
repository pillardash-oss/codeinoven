/**
 * Shared records for a thread's authored work.
 *
 * Two sessions have the same shape: a design session (`@cio-design`, written into
 * `.cio/designs/<name>/`) and a video session (`@cio-video`, written into
 * `.cio/videos/<name>/`). Both are user-started, both are a folder of HTML the
 * agent writes, and both need the same answer after a restart: which folder was
 * this thread working in, and how does the user get back to it. Only the words
 * differ, so the kind travels with them and every label is chosen from it.
 *
 * Everything here exists so that knowledge outlives the process. The tag lives in
 * the thread's persisted messages, and the folder a thread is working on, together
 * with the kind of work it holds, lives in the `thread_designs` table, so a restart
 * can put the user back on their work instead of leaving them with a browser tab
 * that no longer knows it was showing one.
 */

import type { WorkRoots } from '../design/work-roots'

/** Which authored-work session a thread is in. */
export type AuthoredWorkKind = 'design' | 'video'

/** One folder of a thread's authored work: a design, or a video composition. */
export interface DesignEntry {
  /** Project-relative folder with forward slashes, e.g. `.cio/videos/title`. */
  directory: string
  /** Folder name, for a label, e.g. `hero`. */
  name: string
  /** Whether the folder holds an `index.html` entry file. */
  hasEntry: boolean
  /** Latest modification time inside the folder (ms), for newest-first ordering. */
  updatedAt: number
}

/** The folder a thread last previewed, if it has one. */
export interface ThreadDesignCurrent {
  /** Project-relative folder with forward slashes. */
  directory: string
  /** Entry file inside the folder, or null to show the folder listing. */
  entry: string | null
  /**
   * Which session the folder holds, recorded when the folder was written.
   *
   * Stored rather than recovered by reading the path, so a thread that has done
   * design or video work stays marked on its row even when its folder has been
   * renamed, deleted, or written outside the layout the app documents.
   */
  kind: AuthoredWorkKind
  /**
   * When the thread last previewed it (ms). The folder is the newest evidence of
   * which session a thread is in, so the coordinator weighs it against the two
   * session tags rather than trusting the order they happen to be scanned in.
   */
  updatedAt: number
}

/** Everything a coordinator needs to render one thread's authored work. */
export interface ThreadDesignState {
  projectId: string
  threadId: string
  /** Which session the thread is in, which chooses every word on the board. */
  kind: AuthoredWorkKind
  /**
   * Whether this thread opened a session. Derived from the persisted messages,
   * so it survives a restart and a later edit that removes the tag.
   */
  active: boolean
  /** The folder this thread last previewed, or null before the first preview. */
  current: ThreadDesignCurrent | null
  /** Every folder of `kind` in the project, newest first. */
  items: DesignEntry[]
  /** Project-relative folder a preview should open when none is chosen. */
  defaultDirectory: string
  /**
   * The folder this kind of work is written into, which is the user's setting.
   *
   * The board labels itself with it, so it has to come from main rather than from
   * the renderer's copy of the config: the two can be a save apart, and a board
   * naming the folder the work is not in is worse than naming none.
   */
  root: string
}

/**
 * What one changed work folder moved.
 *
 * A root is app-wide, so one change touches every project. This is the account of
 * it the user gets: how much moved, and what was deliberately left alone.
 */
export interface WorkRootRelocationReport {
  kind: AuthoredWorkKind
  /** The folder the work was in. */
  from: string
  /** The folder it moved to. */
  to: string
  /** Projects that held work in the old folder and were visited. */
  projects: number
  /** Folders moved into the new folder. */
  moved: number
  /** Thread records re-pointed at their folder's new path. */
  rebased: number
  /** Folders left in place because the destination already had that name. */
  clashes: { project: string; name: string }[]
  /** Folders that could not be moved at all. */
  failed: { project: string; name: string; reason: string }[]
}

/** The folders authored work is written into, and what the last change moved. */
export interface WorkRootState {
  /** The folders in use now. */
  roots: WorkRoots
  /** The folders Reset returns to. */
  defaults: WorkRoots
  /** What the last change moved, empty until a root is changed. */
  reports: WorkRootRelocationReport[]
}

/** The result of showing a design in the in-app browser. */
export interface DesignOpenResult {
  /** Project-relative folder that was served. */
  directory: string
  /** Entry file shown, or null for the folder listing. */
  entry: string | null
  /** The loopback URL the tab is showing. */
  url: string
  /** The browser tab showing it. */
  tabId: string
}

/** A capture of a design, for the coordinator's preview. */
export interface DesignThumbnail {
  directory: string
  /** PNG data URL, or null when the design could not be captured. */
  dataUrl: string | null
  /** Capture size in CSS pixels, for the preview's aspect ratio. */
  width: number
  height: number
  /**
   * The browser tab holding the work, or null when there is none.
   *
   * The board needs it to reach the tab's own controls. A composition's mute is per
   * tab, so the board's mute button drives the same state the tab strip shows
   * rather than keeping a second one that could disagree with it.
   */
  tabId: string | null
}
