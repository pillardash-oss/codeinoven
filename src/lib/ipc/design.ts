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

import type { ScreenCanvasSketch } from '../design/screen-canvas'

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
  /** A registered folder that no longer exists remains visible until removed. */
  missing?: boolean
  /**
   * When the folder was made (ms), for the board's "created" stamp.
   *
   * The filesystem's birth time is the design's own creation; a volume that does
   * not record one stands its change time in, which is the closest thing it has.
   * Zero means the folder could not be read at all.
   */
  createdAt: number
  /** Latest modification time inside the folder (ms), for newest-first ordering. */
  updatedAt: number
  /**
   * The thread that created this folder, or null when nothing recorded it.
   *
   * Recorded the first time any thread previews the folder, because the agent
   * writes a folder before showing it, so the first previewer is the thread the
   * work belongs to. The board uses it to reveal that thread and to badge the
   * folder as the viewed thread's own, rather than badging whatever folder the
   * thread happened to open last. A folder found on disk that nothing has
   * previewed yet, or one whose creating thread has been deleted, has none.
   */
  creatorThreadId: string | null
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
   * The folder this kind of work is written into, which is the project's record.
   *
   * The board labels itself with it, so it has to come from main rather than from
   * the renderer's copy of the config: the two can be a save apart, and a board
   * naming the folder the work is not in is worse than naming none.
   */
  root: string
}

/**
 * Every folder of authored work one project holds, by kind.
 *
 * The rail shows a design or video entry for the project itself, and the question
 * is asked before any thread is chosen, so the answer cannot come from a session:
 * it is the two roots read straight. Each folder's `creatorThreadId` is the thread
 * that first previewed it, or null when nothing recorded one.
 */
export interface ProjectWorkState {
  projectId: string
  /** Design folders in the project's design root, newest first. */
  design: DesignEntry[]
  /** Composition folders in the project's video root, newest first. */
  video: DesignEntry[]
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

/**
 * One screen of a design: an HTML file the preview can be aimed at.
 *
 * A design is a product rather than a page, so its screens are its files rather
 * than its folders. The board reads them to show one picture per screen, and
 * `entry` is spelled exactly as a preview's own `entry` argument takes it, so the
 * board opens the screen it is showing without translating anything.
 */
export interface DesignScreen {
  /** File inside the design folder, e.g. `index.html` or `pages/pricing.html`. */
  entry: string
  /** Label for the board: the file's path without its extension. */
  name: string
  /**
   * Latest modification time of the file (ms).
   *
   * Carried because a picture of a screen is only worth keeping until the screen
   * changes, and this is what says whether it has.
   */
  updatedAt: number
}

/**
 * One screen as the board shows it: its name, and a picture when there is one.
 *
 * A screen with no picture is still reported. A design whose files are being
 * written has a screen the app has not rendered yet, and a board that dropped it
 * would make the design look smaller than it is.
 */
export interface DesignScreenShot {
  /** File inside the design folder, as a preview `entry` spells it. */
  entry: string
  /** Label for the board. */
  name: string
  /** PNG data URL, or null when this screen has no picture yet. */
  dataUrl: string | null
  /** Picture size in CSS pixels, for the board's aspect ratio. 0 with no picture. */
  width: number
  height: number
  /**
   * Latest modification time of the file (ms).
   *
   * Carried so the board can order its screens by what moved last, with the
   * newest at the top, without a second read of the folder. It is the same stamp
   * the picture is cached against.
   */
  updatedAt: number
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

/**
 * What produced a point in a design's history.
 *
 * A design is iterated, and the point of keeping its history is that the user can
 * walk back through the iterations without fear. The cause is what the board uses
 * to say who moved the work: the app when the folder was first seen, the agent
 * when a turn settled, or the user editing the files directly.
 */
export type DesignRevisionCause = 'initial' | 'agent' | 'user'

/** Result of an explicit named agent checkpoint. */
export interface DesignCheckpointResult {
  directory: string
  entry: string
  label: string
  revisionId: string | null
  checkpointed: boolean
  gitBacked: boolean
}

/**
 * One point in a design's history: a snapshot the user can return to.
 *
 * The revision is content, not a diff: undoing restores the folder to exactly the
 * files this revision holds. Only the facts a timeline row needs travel here; the
 * snapshot itself stays in main, addressed by id.
 */
export interface DesignRevisionSummary {
  id: string
  /** Position in the folder's history, oldest first, starting at 1. */
  sequence: number
  /** What produced the change this revision captured. */
  cause: DesignRevisionCause
  /** Named agent step, for example "Hero title updated". */
  label?: string
  /** Screen whose step was checkpointed. */
  checkpointEntry?: string
  /** When the snapshot was taken (ms). */
  createdAt: number
  /** Files added, changed, or removed from the revision this one follows. */
  changedFiles: number
  /**
   * The paths added, changed, or removed from the revision this one follows, so a
   * row can name what moved and a page can be picked out of the timeline.
   */
  changedPaths: string[]
  /** Files the snapshot holds. */
  fileCount: number
  /** Total size of the snapshot's files, in bytes. */
  totalBytes: number
}

/** One file the timeline has touched, for the page scope picker. */
export interface DesignHistoryFile {
  /** Screen name shown to the user. */
  name: string
  /** Path inside the design folder, with forward slashes. */
  path: string
  /** How many revisions added, changed, or removed it. */
  changeCount: number
  /** Whether the newest revision still holds it. */
  present: boolean
}

/**
 * One page's own line through the history, for a fine-grained undo.
 *
 * A design is iterated a page at a time, and a whole-folder undo is too blunt when
 * the user only wants to take one page back. The page's states are the distinct
 * contents it held, oldest first, read from the folder revisions: stepping between
 * two neighbours restores exactly one file and leaves every other page where it is.
 */
export interface DesignPageRevision {
  label?: string
  /** The revision whose content this state was read from. */
  revisionId: string
  /** Position on the folder's timeline, oldest first. */
  sequence: number
  /** When that revision was taken (ms). */
  createdAt: number
  /** Whether the file existed at this state (false means restoring deletes it). */
  present: boolean
}

/** One page's history, and where the page currently sits in it. */
export interface DesignPageHistoryState {
  gitBacked: boolean
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** The file this line belongs to. */
  path: string
  /** Distinct states the page held, oldest first. */
  revisions: DesignPageRevision[]
  /** Index of the state the page is at, or `revisions.length` when it matches none. */
  cursorIndex: number
  /** Whether the page on disk is a state the history does not hold (a hand edit). */
  modified: boolean
  canUndo: boolean
  canRedo: boolean
}

/** A page restore's answer: the folder's history, and the page's own line after it. */
export interface DesignHistoryRestoreFileResult {
  history: DesignHistoryState
  page: DesignPageHistoryState
}

/**
 * One authored-work folder's history, as the board reads it.
 *
 * A folder is the unit: a design and a composition each get their own timeline,
 * and the two capabilities share this shape the same way they share the board.
 * `cursorIndex` is where the folder currently sits, so Undo and Redo know which
 * step is next without the renderer recomputing it from ids.
 */
export interface DesignHistoryState {
  /** Project-relative folder, with forward slashes. */
  directory: string
  /**
   * Whether Git already tracks this folder, so the app keeps no history of its own.
   *
   * A user who keeps their designs in the repository is tracking them already, and
   * a second timeline would only disagree with Git's. The board says so and offers
   * no Undo rather than pretending there is nothing to go back to.
   */
  gitBacked: boolean
  /** Revisions oldest first. */
  revisions: DesignRevisionSummary[]
  /** The revision the folder is currently at, or null when there is no history. */
  cursorId: string | null
  /** Index of `cursorId` in `revisions`, or -1. */
  cursorIndex: number
  /**
   * Whether the folder on disk matches no single revision, because a page-scoped
   * undo or a hand edit left it holding a mixture of states the timeline already
   * knows. The board says so instead of pretending the folder is at a point, and
   * a capture that finds such a mixture records no new revision.
   */
  modified: boolean
  /** Every file the timeline has touched, for the page scope picker. */
  files: DesignHistoryFile[]
  canUndo: boolean
  canRedo: boolean
}

/**
 * The Screen Canvas of one design folder: the page that shows every screen at once.
 *
 * The canvas is the app's, generated from the folder on every request, so this is
 * what it is made of rather than a copy of it: the screens it frames in order, the
 * states still declared as ideas, and anything `canvas.json` names that no longer
 * exists. Nothing in here can be out of date, because the folder is the source.
 */
export interface ScreenCanvasState {
  /** Project-relative folder the canvas belongs to, with forward slashes. */
  directory: string
  /** Reserved path the app serves the canvas at, always `__cio/canvas.html`. */
  entry: string
  /** Frames side by side on the canvas. */
  columns: number
  /** Screens the canvas frames, in the order it shows them. */
  screens: string[]
  /** States declared in the design's metadata that have no screen file yet. */
  sketches: ScreenCanvasSketch[]
  /**
   * Entries the design's metadata names that the folder no longer holds.
   *
   * The canvas drops them rather than framing a file that is gone, and the board
   * says so instead of leaving the metadata silently disagreeing with the folder.
   */
  orphanFrames: string[]
  /** Why the design's `canvas.json` could not be read, or null when it did. */
  metadataError: string | null
}

/**
 * How far a save-path change reaches, stated by the caller that asked for it.
 *
 * One change is either about a single folder or about where new work is written,
 * and there is no third combination to guess: `work` moves the one folder the
 * change names and leaves the project's folder for new work alone, `project`
 * records the project's folder for new work and moves nothing, because a folder
 * that already holds a design or a composition is not the setting's to move. The
 * two sides used to be spelled as separate booleans, which let a request mean one
 * thing on the board and another in the settings page.
 */
export type WorkDetailsScope = 'work' | 'project'

export interface UpdateWorkDetails {
  kind: AuthoredWorkKind
  directory: string
  root?: string
  scope: WorkDetailsScope
  name?: string
}
export interface UpdateWorkDetailsResult {
  /** The folder the board should show: the moved folder, or the one it asked about. */
  directory: string
  /** How many folders moved. A save-folder change moves none. */
  moved: number
}

/**
 * How the board draws a project's designs: pictures of them, or a folded list.
 *
 * A grid of thumbnails answers "which one is this"; a list of groups answers
 * "where is it" once a project holds more designs than fit on one screen. The
 * same folders are behind both, so this is a reading of the work rather than a
 * different set of it.
 */
export type WorkGroupView = 'cards' | 'list'

/**
 * One named group of a project's authored work.
 *
 * A group is the user's own organisation of the board, not a place on disk: the
 * folders stay exactly where they are and the group is a record about them. That
 * is what makes grouping safe to do freely, and it is why deleting a group
 * returns its designs to the board ungrouped instead of touching a single file.
 */
export interface WorkGroup {
  /** Stable id, mentioned by the agent and used to move designs between groups. */
  id: string
  /** Which session's work the group holds. */
  kind: AuthoredWorkKind
  /** Name the user gave it, e.g. `Marketing site`. */
  name: string
  /** Position among the project's groups of this kind, lowest first. */
  position: number
  /** Whether the board shows the group's designs folded away. Persisted so a
   *  folded group is still folded after a restart. */
  collapsed: boolean
  createdAt: number
  updatedAt: number
}

/**
 * One design's place in a group, and its order inside it.
 *
 * A design with no membership row is ungrouped: the absence of a record is the
 * whole of "not in a group", so no design has to be written to when a project
 * starts using groups.
 */
export interface WorkGroupMember {
  /** Project-relative folder with forward slashes. */
  directory: string
  /** The group holding it. */
  groupId: string
  /** Position inside that group, lowest first. */
  position: number
}

/**
 * Everything the board knows about how a project's designs are organised.
 *
 * Groups and memberships travel together with the view and one change stamp,
 * because the board draws all of it at once and an agent asking what the user
 * arranged needs the same answer in one read.
 */
export interface WorkGroupState {
  projectId: string
  kind: AuthoredWorkKind
  /** Groups in board order. */
  groups: WorkGroup[]
  /** Membership of every grouped design; a folder absent from this list is
   *  ungrouped. */
  members: WorkGroupMember[]
  /** How the board draws the work: pictures, or the folded list. */
  view: WorkGroupView
  /**
   * When the user last changed the organisation (ms), or 0 when they never have.
   *
   * It is the stamp that tells a reader its answer is stale: an agent that read
   * the groups earlier compares this against what it read, and the board uses it
   * to know a change came from another window.
   */
  updatedAt: number
}

/** One design the board should put in a group, for a single drop. */
export interface WorkGroupMove {
  /** Project-relative folder with forward slashes. */
  directory: string
  /** Destination group, or null to return the design to the ungrouped list. */
  groupId: string | null
  /** Position inside the destination group; omitted appends to the end. */
  position?: number
}

/**
 * How the screens of one design are ordered.
 *
 * The four automatic orders are read off the files themselves; `custom` is the
 * arrangement the user dragged, and a screen written after that arrangement is
 * drawn before the placed ones rather than appended to them.
 */
export type ScreenBoardOrder = 'latest' | 'name' | 'name-desc' | 'oldest' | 'custom'

/** One named group of one design's screens. */
export interface ScreenGroup {
  id: string
  name: string
  /** Position among the design's groups, lowest first. */
  position: number
  /** Whether the board draws the group folded. Persisted, so it reopens folded. */
  collapsed: boolean
}

/** One screen's group and its place in the order the user arranged. */
export interface ScreenBoardPlacement {
  /** Project-relative screen path inside the design folder, e.g. `checkout.html`. */
  entry: string
  /** The group holding it, or null when it sits in the ungrouped list. */
  groupId: string | null
  /** Position among its group's screens, lowest first. */
  position: number
}

/**
 * Everything the board knows about how one design's screens are organised.
 *
 * The reading itself (`view`) is app-wide and travels with every answer, so one
 * window's click is the reading every design board shows, including one opened
 * afterwards.
 */
export interface ScreenBoardState {
  projectId: string
  /** Project-relative design folder with forward slashes. */
  directory: string
  groups: ScreenGroup[]
  placements: ScreenBoardPlacement[]
  order: ScreenBoardOrder
  view: WorkGroupView
  /** When the user last changed the arrangement (ms), or 0 when they never have. */
  updatedAt: number
}
