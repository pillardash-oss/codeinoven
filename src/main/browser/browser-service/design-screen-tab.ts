import { createHash } from 'node:crypto'

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
 * The thread is part of the identity, not just the project: two threads may work
 * in the same project folder, and each is looking at its own page.
 *
 * Kept out of the browser service so the rule is a pure function that can be
 * exercised on its own, and so a caller that only wants to know the id does not
 * need a browser window to ask.
 */
export function designScreenTabId(input: {
  projectId: string
  threadId: string
  /** Project-relative folder of the design, with forward slashes. */
  directory: string
  /** Entry file of the screen, as a URL path, or null for the folder listing. */
  entry: string | null
}): string {
  const identity = [input.projectId, input.threadId, input.directory, input.entry ?? ''].join(
    '\u0000'
  )
  return `browser:screen:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}
