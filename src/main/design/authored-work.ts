/**
 * Authored work: where a design or a composition lives, and how it is found.
 *
 * A design and a composition are the same sort of thing to the app: a folder of
 * work one level below the kind's folder (`.cio/designs/<name>`, `.cio/videos/<name>`),
 * written by an agent, kept in one of the project's checkouts, and listed by a board.
 * This module is the single pipeline both boards use, so a decision about where that
 * work lives is made once:
 *
 * - `authoredWorkRoot` is the primary root of a conversation: its own workspace, or
 *   the project checkout new work is written into.
 * - `authoredWorkRoots` is every checkout the project's work can be in, primary
 *   first, which is what makes work reachable from every thread instead of only the
 *   scope that happened to be on screen.
 * - `findAuthoredWork` / `findAuthoredWorkFile` resolve the spelling a caller used
 *   to the checkout that really holds it.
 * - `listAuthoredWork` is the listing both boards draw.
 *
 * Nothing outside this module may decide which root a folder belongs to, or spell a
 * folder as if it were always project-relative: that is how a design made in one
 * scope once became invisible from every other one.
 */
export { authoredWorkRoot, type AuthoredWorkRoot } from './authored-work/roots'
export { authoredWorkRoots, installAuthoredWorkScopeRoots } from './authored-work/scope-roots'
export {
  findAuthoredWork,
  findAuthoredWorkFile,
  resolveAuthoredWork,
  rootRelativePath,
  slashPath,
  type AuthoredWorkFolder,
  type AuthoredWorkQuery
} from './authored-work/placement'
export { listAuthoredWork, type AuthoredWorkListing } from './authored-work/listing'
