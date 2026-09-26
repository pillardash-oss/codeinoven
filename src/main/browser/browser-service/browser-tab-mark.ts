import type { BrowserCompositionTab, BrowserDesignTab } from '../../../lib/ipc-contract'
import { originOf } from '../../../lib/local-development-url'

/**
 * What the app knows about the folder a browser tab is showing, as a pure decision.
 *
 * Kept apart from `BrowserService` because the rule has nothing to do with a
 * WebContentsView: it is a function of the page URL, the mark the tab already
 * carried, and whatever the app recognised from that URL. Separated this way it can
 * be exercised directly, and the service keeps only the wiring: read the URL, ask
 * the app, publish the change.
 *
 * Two capabilities hang off one recognition because it answers one question, which
 * authored-work folder is this tab showing: a design folder arms the element
 * inspector, and a composition folder arms the playback transport. Marking them
 * separately would let a tab be one to the panel and not the other.
 */

/** What the app recognises about one served folder. */
export interface BrowserTabMark {
  /** A design folder, whose elements the user picks and comments on. */
  design: BrowserDesignTab | null
  /** A composition folder, whose timeline the app drives. */
  composition: BrowserCompositionTab | null
}

/** The mark a tab carries while it shows something the app knows nothing about. */
export const NO_TAB_MARK: BrowserTabMark = Object.freeze({ design: null, composition: null })

/**
 * How a tab is recognised from the page it is showing, and how that recognition
 * is reported.
 *
 * The app supplies it, because answering it needs the preview registry (which
 * folder is on which loopback origin) and a project's authored-work roots, neither
 * of which the browser knows about. It is asked on every committed navigation and
 * nowhere else, so the rule that sets a mark and the rule that clears it stay one
 * rule. It answers asynchronously because a composition's mark carries the
 * timeline its manifest declares, and that has to be read.
 */
export type TabMarkRecogniser = (
  projectId: string,
  threadId: string,
  url: string
) => Promise<BrowserTabMark>

function sameDesign(left: BrowserDesignTab | null, right: BrowserDesignTab | null): boolean {
  if (left === null || right === null) return left === right
  return left.directory === right.directory && left.origin === right.origin
}

function sameComposition(
  left: BrowserCompositionTab | null,
  right: BrowserCompositionTab | null
): boolean {
  if (left === null || right === null) return left === right
  return (
    left.directory === right.directory &&
    left.origin === right.origin &&
    left.duration === right.duration &&
    left.fps === right.fps &&
    left.width === right.width &&
    left.height === right.height
  )
}

/**
 * Whether two marks describe the same page.
 *
 * Every field is compared, so a manifest the agent lengthened moves the mark and
 * the transport is re-armed with the new timeline instead of the old one.
 */
export function isSameTabMark(left: BrowserTabMark, right: BrowserTabMark): boolean {
  return (
    sameDesign(left.design, right.design) && sameComposition(left.composition, right.composition)
  )
}

/**
 * The mark a tab should carry, from what the app recognised and what it already had.
 *
 * A recognised mark is taken whole. Recognising a composition where a design was
 * marked means the tab is now a composition, and keeping a stale field from the
 * previous answer is how the transport stays armed for a folder that is gone.
 *
 * Recognising nothing keeps the previous mark while the origin is unchanged,
 * because the one thing that can make a served folder unrecognisable without the
 * tab having moved is the preview server being dropped by the live-server cap: a
 * tab still showing its design must not lose the inspector, and a tab still
 * showing its composition must not lose the transport bar.
 */
export function tabMarkFor(
  url: string,
  previous: BrowserTabMark,
  recognised: BrowserTabMark
): BrowserTabMark {
  if (recognised.design !== null || recognised.composition !== null) return recognised
  const keptOrigin = previous.composition?.origin ?? previous.design?.origin ?? null
  if (keptOrigin !== null && originOf(url) === keptOrigin) return previous
  return NO_TAB_MARK
}
