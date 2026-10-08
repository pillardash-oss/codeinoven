/**
 * The vocabulary of the global browser agent tab's native context menu.
 *
 * The rail tab is a view of a real assistant thread, so the menu names the
 * conversation and offers what a conversation tab can do: rename it inline,
 * copy its thread id for bug reports, and close (delete) it.
 */

export interface BrowserAgentTabMenuInput {
  /** Display title shown as the disabled menu header. */
  title: string
  /** Assistant thread id behind the tab, copied verbatim, never displayed. */
  threadId: string
}

export type BrowserAgentTabMenuChoice =
  | { action: 'rename' }
  | { action: 'copyThreadId' }
  | { action: 'close' }
