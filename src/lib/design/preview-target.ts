/**
 * What a preview target is, named so the app can find it again.
 *
 * A design is shown one page at a time: the Screen Canvas, the design's own
 * entry page, or one screen of the folder. Each of those is a target, and the
 * app gives each one a browser tab and serves its folder on a loopback origin.
 * Clicking a target that is already open has to land in the tab it already has
 * rather than stack a second one, and the same has to hold after the app has
 * been quit and started again, so the identity is derived from what the target
 * is rather than minted when the tab is made.
 *
 * Shared between main and the renderer because both must agree on it: main
 * names the tab and records the loopback port against the target, and the
 * browser tab the user restores after a restart is recognised by the same id.
 */

/** One page a preview can show, described by what it is rather than by its tab. */
export interface PreviewTarget {
  projectId: string
  /**
   * The thread looking at the page.
   *
   * Part of the identity and not only the project: two threads may work in the
   * same project folder, and each is looking at its own page.
   */
  threadId: string
  /** Project-relative folder of the design, with forward slashes. */
  directory: string
  /**
   * Entry inside the folder, as a URL path, or null for the folder listing.
   *
   * The resolved entry rather than the spelling the caller used, so the live
   * preview opened as `index.html` and a screen clicked as the same file are one
   * target with one tab.
   */
  entry: string | null
}

/** The folder a preview is served from, which is what a loopback server belongs to. */
export type PreviewFolder = Omit<PreviewTarget, 'entry'>

/**
 * The identity of one preview target, stable across a restart.
 *
 * Nothing is minted and nothing is random: the same page of the same design in
 * the same thread always answers with the same id. That is what lets a click on
 * an open screen reach the tab serving it, and what lets a tab the renderer
 * restored onto a page the app served before be recognised as that page's tab.
 */
export function previewTargetId(target: PreviewTarget): string {
  return [target.projectId, target.threadId, target.directory, target.entry ?? ''].join('\u0000')
}

/**
 * The identity of one preview folder, which is what one preview server belongs to.
 *
 * A server serves a folder, not a page, so every screen of one design shares it:
 * the port is a property of the folder, and the tabs of the screens inside it
 * are properties of each screen.
 */
export function previewFolderId(folder: PreviewFolder): string {
  return [folder.projectId, folder.threadId, folder.directory].join('\u0000')
}
