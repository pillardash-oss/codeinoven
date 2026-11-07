import { createHash } from 'node:crypto'
import { previewTargetId, type PreviewTarget } from '../../../lib/design/preview-target'

/**
 * The tab one design screen is shown in, named from what the screen is.
 *
 * A canvas in the design coordinator is a page the user chose, and choosing a
 * second one must not replace the first one's tab. That needs a tab id per
 * screen that the app can find again, so the id is derived from the screen's
 * identity rather than minted: the same screen always resolves to the same tab,
 * which is what lets a click replace its own tab and only its own. Deriving it
 * also survives a restart, where a minted id would come back as a second copy of
 * a tab the user still has open.
 *
 * The identity itself lives in `preview-target`, shared with the registry that
 * remembers which tab and server each target was given: the app must derive the
 * tab a screen gets and remember the tab it was shown in by the same rule, or the
 * two disagree about what "the same screen" means.
 *
 * Kept out of the browser service so the rule is a pure function that can be
 * exercised on its own, and so a caller that only wants to know the id does not
 * need a browser window to ask.
 */
export function designScreenTabId(target: PreviewTarget): string {
  return `browser:screen:${createHash('sha256').update(previewTargetId(target)).digest('hex').slice(0, 32)}`
}
