import { DESIGN_OUTPUT_ROOT } from '../design-skill'
import type { AuthoredWorkKind } from '../ipc/design'
import { VIDEO_PROJECT_ROOT } from '../video/project'

/**
 * Which authored-work session a folder belongs to, from the folder's root.
 *
 * A design session writes into `.cio/designs/<name>/` and a video session writes
 * into `.cio/videos/<name>/`, and the root is the only thing that says which is
 * which. Everything else that talks about this work carries a bare path: the
 * `thread_designs` row stores a path, a served origin stores a path, and a
 * browser tab stores the URL it is showing. None of them stores a kind.
 *
 * So the classifier lives here rather than inside the service that happened to
 * need it first, because three callers now ask the same question: the design
 * service when it decides which session a thread is in, and the browser when it
 * decides whether a tab is rendering a design. A second copy is how a folder ends
 * up being a design to the board and not to the tab.
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
