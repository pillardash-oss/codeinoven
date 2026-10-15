import { createHash } from 'node:crypto'

/**
 * The view one composition board plays its composition in, named from what it
 * shows.
 *
 * The board is a player, not a browser page the user navigated to, so its view
 * must not appear in the tab strip. It is still an ordinary registered browser
 * tab, because the tab-mark pipeline and the transport both read the tab
 * registry, and the one thing that puts a tab in the strip is the
 * `browser:openRequested` event. A view opened without that event is invisible
 * to every surface that lists tabs and fully wired for the transport.
 *
 * The id is derived rather than minted, exactly as a design screen's is (see
 * {@link designScreenTabId}): the same composition always resolves to the same
 * view, so re-opening the board finds the view it already has instead of
 * stacking a second one, and a view that outlives a renderer reload comes back
 * as itself.
 *
 * The folder is part of the identity: one board can move from composition to
 * composition, and leaving one must not reload the other's page under it.
 *
 * Kept out of the browser service so the rule stays a pure function that can be
 * exercised on its own.
 */
export function compositionBoardTabId(input: {
  projectId: string
  threadId: string
  /** Project-relative folder of the composition, with forward slashes. */
  directory: string
}): string {
  const identity = [input.projectId, input.threadId, input.directory].join('\u0000')
  return `browser:board:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}
