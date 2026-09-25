import type { BrowserDesignTab } from '../../../lib/ipc-contract'
import { originOf } from '../../../lib/local-development-url'

/**
 * Which design a browser tab is showing, as a pure decision.
 *
 * Kept apart from `BrowserService` because the rule has nothing to do with a
 * WebContentsView: it is a function of the page URL, the mark the tab already
 * carried, and whatever the app recognised from that URL. Separated this way it can
 * be exercised directly, and the service keeps only the wiring: read the URL, ask
 * the app, publish the change.
 */

/**
 * How a tab is recognised as showing a design, and how that recognition is
 * reported.
 *
 * The app supplies it, because answering it needs the preview registry (which
 * folder is on which loopback origin) and a project's design root, neither of which
 * the browser knows about. It is asked on every committed navigation and nowhere
 * else, so the rule that sets a mark and the rule that clears it stay one rule.
 */
export type DesignTabRecogniser = (
  projectId: string,
  threadId: string,
  url: string
) => BrowserDesignTab | null

/** Whether two marks name the same folder on the same origin. */
export function isSameDesign(
  left: BrowserDesignTab | null,
  right: BrowserDesignTab | null
): boolean {
  if (left === null || right === null) return left === right
  return left.directory === right.directory && left.origin === right.origin
}

/**
 * The mark a tab should carry, from what the app recognised and what it already had.
 *
 * A tab still on the origin it was marked for keeps its mark, because a preview
 * server dropped by the live-server cap must not disarm the inspector for a page
 * that is still a design. The recognised folder wins otherwise, so a tab that
 * navigated away loses the mark and a tab that arrived on a design folder gains one
 * whether or not the design capability opened it.
 */
export function designTabFor(
  url: string,
  previous: BrowserDesignTab | null,
  recognised: BrowserDesignTab | null
): BrowserDesignTab | null {
  const kept = previous !== null && originOf(url) === previous.origin ? previous : null
  return recognised ?? kept
}
