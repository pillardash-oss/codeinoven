/**
 * The vocabulary of the thread browser's rail context menu.
 *
 * The rail icon sits in the renderer, but its menu opens over a native
 * `WebContentsView`, which composites above every DOM node. The menu is
 * therefore an OS popup built in main, and this shape is the one both sides
 * read: main names the action the user picked, and the renderer owns the work
 * behind it.
 */

/** One action the rail menu can answer with, or null when it was dismissed. */
export interface BrowserRailContextMenuChoice {
  action: 'closeAllTabs' | 'closeBrowser' | 'downloads' | 'clearData'
}
