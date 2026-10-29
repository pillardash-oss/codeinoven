import type { AuthoredWorkKind } from '$shared/ipc-contract'

/**
 * The coordinator board for a thread's authored work.
 *
 * A session's work is a folder of HTML, and the user's question after a restart is
 * "where did my design go?" or "where did my video go?". This panel answers it: the
 * folder in use, a preview of every screen it holds, and the controls that move
 * between designs, bring one on screen, or ask the agent for more.
 *
 * The panel is a header plus one scrolling surface. The header owns the design in
 * front, the refresh and the menu; every other design of the project sits behind
 * the dropdown beside it, so a project with a dozen designs still shows one tab
 * and a way to reach the rest. The surface is the board, and its first two entries
 * are the two pages
 * that are not screens: the Screen Canvas that shows every screen at once, and the
 * live preview a visitor lands on. Everything after them is a screen of the folder
 * in front, all the same size: a picture is a picture of a screen, not the screen
 * itself, and the one in front is marked rather than enlarged.
 *
 * The canvas is the app's own page: generated from the folder's screens every
 * time it is asked for, so a screen written a minute ago is on it, there is
 * nothing for the board to warn about and nothing for the agent to keep in step.
 * The board only opens it.
 *
 * It loads its own state rather than receiving it through props, because the work
 * outlives the turn that made it: there is no live turn to hand it anything, and a
 * restarted app has to fill this in from main alone.
 */

export interface Props {
  viewingThreadId?: string
  projectId: string
  threadId: string
  /**
   * The kind this board shows, when the project's rail opened it rather than a
   * session. A session board reads its kind from the thread; the rail's entry
   * offers the project's designs or videos on whatever thread the user is on,
   * so it sets the kind here.
   */
  kind?: AuthoredWorkKind
  active?: boolean
}

/**
 * The orders the board can show a design's screens in.
 *
 * Latest is where the board starts, because a design is iterated and the screen
 * that moved last is usually the one the user came to look at. The other three
 * are what a person reaches for when they know a screen's name instead.
 */
export const SCREEN_ORDERS = ['latest', 'name', 'name-desc', 'oldest'] as const

export type ScreenOrder = (typeof SCREEN_ORDERS)[number]
