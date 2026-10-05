import type { MainView } from '$lib/stores/renderer-recovery'

/**
 * Which views already show a project's threads.
 *
 * A project picked for focus belongs in a view that is already showing it, so
 * that view keeps its place and only the project and the open thread change.
 * What decides it is the one project a view shows at a time: the scoped state
 * is the docked project's own thread list, the Scope board is focused on a
 * single project, and the Threads timeline shows only the projects its project
 * filter lets through. The plain Projects page lists every project, so it always
 * shows one.
 *
 * Every other view (Chats, Assistant, the browser and the takeover pages) shows
 * no project threads at all, so a project focused from one of them has to be
 * shown where it belongs: the Projects view.
 */
export interface ProjectViewContext {
  /** The project the scoped-state sidebar is docked on, when it is open. */
  scopedProjectId: string | null
  /** Whether the Threads timeline's project filter lets the project through. */
  threadsViewShowsProject: boolean
  /** The project the Scope board is focused on, when that page is on screen. */
  boardProjectId: string | null
}

/**
 * True when the view on screen already shows a project, so focusing that
 * project must not move the user off it.
 */
export function viewShowsProject(
  view: MainView,
  projectId: string,
  context: ProjectViewContext
): boolean {
  if (view === 'scope') return context.boardProjectId === projectId
  if (view === 'threads') return context.threadsViewShowsProject
  if (view === 'projects' || view === 'projects-scope') {
    // A docked scoped state is one project's thread list; without one the page
    // is the workspace's own project list, which shows every project.
    return context.scopedProjectId === null || context.scopedProjectId === projectId
  }
  return false
}

/**
 * True while the shell shows the scoped-threads view: its own registered view,
 * or the plain projects view carrying a live scope sidebar (a restore can land
 * there).
 *
 * The scoped state is the one projects state whose sidebar is docked on a
 * single project, so "am I on Scoped?" has to answer the same way in the header
 * switcher, the sidebar and the new-thread router. Nothing else decides it: a
 * view that merely sits over projects (Chats, the board, Settings) is not
 * Scoped, and neither is a projects view whose sidebar was let go.
 */
export function viewShowsScopedSidebar(view: MainView, hasSidebarContext: boolean): boolean {
  return view === 'projects-scope' || (view === 'projects' && hasSidebarContext)
}
