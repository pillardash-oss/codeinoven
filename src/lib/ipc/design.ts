/**
 * Shared records for a thread's design session.
 *
 * A design session is user-started: the user opens a turn with `@cio-design` and
 * the app-owned design capability writes HTML into `.cio/designs/<name>/`.
 * Everything here exists so that knowledge outlives the process. The tag lives
 * in the thread's persisted messages, and the folder a thread is working on
 * lives in the `thread_designs` table, so a restart can put the user back on
 * their design instead of leaving them with a browser tab that no longer knows
 * it was showing one.
 */

/** One design folder in a project. */
export interface DesignEntry {
  /** Project-relative folder with forward slashes, e.g. `.cio/designs/hero`. */
  directory: string
  /** Folder name, for a label, e.g. `hero`. */
  name: string
  /** Whether the folder holds an `index.html` entry file. */
  hasEntry: boolean
  /** Latest modification time inside the folder (ms), for newest-first ordering. */
  updatedAt: number
}

/** The design a thread last previewed, if it has one. */
export interface ThreadDesignCurrent {
  /** Project-relative folder with forward slashes. */
  directory: string
  /** Entry file inside the folder, or null to show the folder listing. */
  entry: string | null
}

/** Everything a design coordinator needs to render for one thread. */
export interface ThreadDesignState {
  projectId: string
  threadId: string
  /**
   * Whether this thread opened a design session. Derived from the persisted
   * messages, so it survives a restart and a later edit that removes the tag.
   */
  active: boolean
  /** The design this thread last previewed, or null before the first preview. */
  current: ThreadDesignCurrent | null
  /** Every design folder in the project, newest first. */
  designs: DesignEntry[]
  /** Project-relative folder a preview should open when none is chosen. */
  defaultDirectory: string
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
}
