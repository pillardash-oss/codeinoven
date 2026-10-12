import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import {
  AUTHORED_WORK_ICON_BY_KIND,
  AUTHORED_WORK_NAME_BY_KIND
} from '$lib/authored-work-presentation'
import type { AuthoredWorkKind, ThreadDesignState } from '$shared/ipc-contract'
import { contextSidebarState } from './context-sidebar.svelte'
import { coordinatorDockState } from './coordinator-dock.svelte'

/**
 * The coordinator's place in the workspace.
 *
 * An authored-work session belongs to a thread, and the panel it docks is the
 * user's way back to the work: which folder it is, a picture of it, and a button
 * that brings the browser tab forward. Two sessions share that board, a design
 * session and a video session, and they differ in the tag, the root and the words.
 * The knowledge lives in main (the `@cio-design` or `@cio-video` tag in the
 * thread's messages, the `thread_designs` row, and the session root's listing), so
 * this store's job is only to ask, publish the panel when the answer says the
 * thread is in a session, and dock it.
 *
 * Nothing here decides whether a thread is in a session: main does, from persisted
 * data, which is what makes this survive a restart, and what makes a session dock
 * the moment its tag lands rather than when the agent first previews something.
 */

/** Rail tooltip and tab title per session, so a video thread is never called a design. */
const COORDINATOR_LABEL_BY_KIND: Record<AuthoredWorkKind, string> = {
  design: `${AUTHORED_WORK_NAME_BY_KIND.design} coordinator`,
  video: `${AUTHORED_WORK_NAME_BY_KIND.video} coordinator`
}

/** Rail icon per session, for the same reason: a composition is not a design. */
const COORDINATOR_ICON_BY_KIND = AUTHORED_WORK_ICON_BY_KIND

/**
 * How long activity on a thread is allowed to coalesce before main is asked
 * again. A session's tag can land on any message, so the coordinator only has to
 * appear promptly, not on every single message; a short settle window keeps a
 * busy turn from re-reading main on each activity change. A thread switch is
 * never held back by this.
 */
const REFRESH_SETTLE_MS = 1000

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`
}

class DesignCoordinatorState {
  /** Last state fetched per thread, so a panel can render before its own load
   *  settles and the rail can label the tab without a second round trip. */
  private readonly states = new SvelteMap<string, ThreadDesignState>()
  /** Threads with a fetch in flight, so a burst of re-attaches cannot stack. */
  private readonly pending = new Set<string>()
  /** Threads whose last read is stale, so one more read has to follow a change
   *  that arrived while a read was in flight. */
  private readonly dirty = new Set<string>()
  /** Trailing reads waiting out the settle window, keyed like `states`. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** When the last read for a thread started, so the window is measured from the
   *  read rather than from the last activity. */
  private readonly startedAt = new Map<string, number>()
  /** The thread the user is on, so a switch is read at once and never throttled. */
  private activeKey: string | null = null
  /** The latest coordinates per thread, for a trailing read that only has a key. */
  private readonly refs = new Map<string, { projectId: string; threadId: string }>()

  /** The last answer for a thread, or null before the first one arrives. */
  stateFor(projectId: string, threadId: string): ThreadDesignState | null {
    return this.states.get(threadKey(projectId, threadId)) ?? null
  }

  /**
   * Ask main what this thread's design looks like, and publish or withdraw the
   * coordinator accordingly.
   *
   * Called when the on-screen thread changes and again whenever that thread sees
   * activity, because a design session can start mid-thread: the `@cio-design`
   * tag arrives on a later message, and the coordinator has to appear then,
   * without the user reloading anything.
   */
  async refresh(projectId: string, threadId: string): Promise<void> {
    const key = threadKey(projectId, threadId)
    const isSwitch = key !== this.activeKey
    this.activeKey = key
    this.refs.set(key, { projectId, threadId })
    this.dirty.add(key)

    if (this.pending.has(key)) return

    // A switch is a new question about a new thread, so it is read at once: the
    // coordinator has to be right the first time the user lands on a thread.
    if (isSwitch) {
      this.clearTrailing(key)
      await this.read(key)
      return
    }

    const elapsed = Date.now() - (this.startedAt.get(key) ?? 0)
    if (elapsed >= REFRESH_SETTLE_MS) {
      await this.read(key)
      return
    }
    this.scheduleTrailing(key, REFRESH_SETTLE_MS - elapsed)
  }

  /** One trailing read per key, so a stream of activity cannot stack reads: the
   *  first change only arms the window, and later changes within it are already
   *  covered by that one. */
  private scheduleTrailing(key: string, delayMs: number): void {
    if (this.timers.has(key)) return
    const timer = setTimeout(() => {
      this.timers.delete(key)
      void this.read(key)
    }, delayMs)
    this.timers.set(key, timer)
  }

  private clearTrailing(key: string): void {
    const timer = this.timers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(key)
  }

  private async read(key: string): Promise<void> {
    if (this.pending.has(key)) return
    const ref = this.refs.get(key)
    if (!ref) return
    // The read that is starting supersedes any trailing read already waiting.
    this.clearTrailing(key)
    this.pending.add(key)
    this.startedAt.set(key, Date.now())
    this.dirty.delete(key)
    const { projectId, threadId } = ref
    try {
      const state = await invoke('design:state', projectId, threadId)
      this.states.set(key, state)
      // The dock holds one registration per row, and an engineering board is the
      // more specific owner of a thread that coordinates work. Design sessions and
      // coordinator threads do not overlap in practice, but nothing may clobber
      // the other's panel if they ever do.
      const existing = coordinatorDockState.forThread(projectId, threadId)
      const ownsRow = existing === null || existing.panel.component === 'design'
      if (!state.active) {
        if (ownsRow && existing !== null) {
          coordinatorDockState.withdraw(projectId, threadId, ['design'])
        }
        return
      }
      if (!ownsRow) return
      const label = COORDINATOR_LABEL_BY_KIND[state.kind]
      coordinatorDockState.register({
        projectId,
        threadId,
        label,
        icon: COORDINATOR_ICON_BY_KIND[state.kind],
        panel: { component: 'design', props: { projectId, threadId } }
      })
      // Docks itself the first time a session appears, unless the user closed it
      // before; later refreshes are no-ops because the tab exists.
      if (
        coordinatorDockState.autoOpen &&
        !contextSidebarState.hasCoordinator(projectId, threadId)
      ) {
        contextSidebarState.openCoordinator(projectId, threadId, label)
      }
    } catch {
      // A failed read leaves the last answer in place rather than blanking a
      // coordinator the user is looking at.
    } finally {
      this.pending.delete(key)
      // A change that arrived while reading still has to be reflected, but only
      // once, and only after the settle window, so a busy thread cannot make the
      // reads run back to back.
      if (this.dirty.has(key)) {
        const elapsed = Date.now() - (this.startedAt.get(key) ?? Date.now())
        this.scheduleTrailing(key, Math.max(0, REFRESH_SETTLE_MS - elapsed))
      }
    }
  }
}

export const designCoordinatorState = new DesignCoordinatorState()
