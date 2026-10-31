import { loadRepositoryPreflight } from '$lib/repository-preflight-cache'
import { INBOX_PROJECT_ID } from '$shared/types'
import { GIT_WARM_TTL_MS } from '../git.svelte'
import type { GitState } from '../git.svelte'

/** GitState panels: one concern, moved verbatim from the composition root. */
export class GitStatePanels {
  constructor(private readonly host: GitState) {}

  /**
   * Panel-open hook: opening the git panel refreshes local status and the
   * connection-gated PR indicators immediately, so what the user sees is
   * never older than the moment they asked for it. When the remote-tracking
   * refs have gone stale it also fetches, because `ahead` and `behind` come
   * from those local refs: without that fetch a branch could sit behind the
   * server, or ahead of it, with nothing in the panel saying so until the user
   * went looking for Fetch in the menu.
   *
   * The project-open hooks above normally fetched already, so a panel open that
   * follows one inside the stale window collapses to the local re-read - which
   * is the point of prefetching: a click on the panel is a click the user wants
   * answered now, not the moment a network round trip may start. This gate stays
   * as the backstop for a project left open long enough to go stale again.
   *
   * The git tool opens from its own rail icon rather than a tab strip, so
   * this fires on every refocus (files → git, notifications → git …). It
   * must therefore never reset the claimed target: `activate(projectId)`
   * without a scope would demote an already-claimed worktree bucket to null,
   * wiping status/branches and forcing the whole panel to visually rebuild.
   * Claiming happens properly elsewhere - the panel's own effect passes the
   * real scope bucket; here we preserve whatever is already active.
   */
  notifyGitPanelOpened(projectId: string): void {
    if (this.host.activeProjectId !== projectId) return
    queueMicrotask(() => this.host.units['runtime'].refreshThenFetchIfDue(projectId))
  }

  /**
   * Warm the Git panel from outside it, for a pointer that is about to open it.
   *
   * Two things sit on the panel's cold path and neither is data the user asked
   * for yet: the repository preflight (a git process spawn, behind which the
   * whole panel hides as "Checking repository"), and the working tree read. The
   * first is filled unconditionally because it is cached per project and shared
   * with the panel, so the panel's own mount finds it already answered. The
   * second is left alone unless it has gone stale, because a hover is a guess and
   * six repository reads is too much to repeat on every pass over the chip.
   *
   * The refresh it does run is a real one and marks Git busy like any other. That
   * is invisible from here because the only caller warms a panel that is closed,
   * and the refresh button is the only thing in the app that reads that flag; a
   * warm-up would otherwise spin it for a click that never came.
   */
  warmGitPanel(projectId: string): void {
    if (!projectId || projectId === INBOX_PROJECT_ID || projectId !== this.host.activeProjectId)
      return
    void loadRepositoryPreflight(projectId).catch(() => undefined)
    if (Date.now() - this.host.statusReadAt < GIT_WARM_TTL_MS) return
    void this.host.refresh(projectId).catch(() => undefined)
  }
}
