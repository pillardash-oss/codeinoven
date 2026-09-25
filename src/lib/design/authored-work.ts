import { DESIGN_OUTPUT_ROOT } from '../design-skill'
import type { AuthoredWorkKind } from '../ipc/design'
import { VIDEO_PROJECT_ROOT } from '../video/project'

/**
 * Which authored-work session a folder belongs to, from the folder's root.
 *
 * A design session writes into `.cio/designs/<name>/` and a video session writes
 * into `.cio/videos/<name>/`, and the root is the only thing that says which is
 * which for a folder that carries no record of its own. A `thread_designs` row
 * carries its kind, so this classifier answers for the places that have none: the
 * folder a served origin resolves to, and the backfill of rows written before the
 * kind column existed.
 *
 * It lives here rather than inside the service that happened to need it first,
 * because more than one caller asks the same question: the service when it decides
 * which session a folder belongs to, the browser when it decides whether a tab is
 * rendering a design, and the database when it classifies historical rows. A
 * second copy is how a folder ends up being a design to the board and not to the
 * tab.
 *
 * Deliberately free of `node:` imports: the renderer imports the roots to label
 * the board, and this module is on that path.
 */

/** The project-relative root each session writes into, which is also how a folder is spelled back. */
export const AUTHORED_WORK_ROOT_BY_KIND: Record<AuthoredWorkKind, string> = {
  design: DESIGN_OUTPUT_ROOT,
  video: VIDEO_PROJECT_ROOT
}

/**
 * Every kind, in the order a folder is tested against its roots.
 *
 * Order matters only for a path that sits under both, which no real folder does;
 * the array exists so the classifier and any caller iterating kinds read them
 * from one place.
 */
export const AUTHORED_WORK_KINDS: readonly AuthoredWorkKind[] = ['design', 'video']

/**
 * Which session a project-relative folder belongs to, read from its root.
 *
 * A path under neither root claims no kind rather than defaulting to a design,
 * because the caller's fallback is its own evidence: the design service falls back
 * to the session tags, and the browser falls back to showing the tab as an
 * ordinary page. Answering "design" here would let an arbitrary previewed folder
 * arm the element inspector.
 */
export function authoredWorkKindOf(directory: string): AuthoredWorkKind | null {
  for (const kind of AUTHORED_WORK_KINDS) {
    const root = AUTHORED_WORK_ROOT_BY_KIND[kind]
    if (directory === root || directory.startsWith(`${root}/`)) return kind
  }
  return null
}
