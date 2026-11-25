/**
 * When a thread browser tab may be slept.
 *
 * A thread browser is the browser a conversation shares with its agent, so "is
 * anybody using this page?" has two answers: a person looking at it, and an agent
 * working on it. These rules own both, so the idle sweep, the tab menu and any
 * future surface cannot disagree about when a page may be taken away.
 *
 * The page is the only thing released. A sleeping tab keeps its row, its title,
 * its icon, its address and its box; main writes its Back/Forward stack down
 * before the view closes, so the next visit reloads the page it was left on.
 */

/** How often the idle sweep runs. One coarse check a minute is enough to keep the
 *  promise "a tab idle for the configured window sleeps", and it costs nothing
 *  between sweeps. */
export const THREAD_HIBERNATION_SWEEP_INTERVAL_MS = 60_000

/**
 * The least a page an agent has used stays awake.
 *
 * An agent works a page across several calls with a model turn between them, and
 * a sleep in that gap would reload the page and drop whatever it had filled in.
 * Ten minutes mirrors the budget main already gives an agent's own page before it
 * releases it, so the floor never outlives the answer the agent gets anywhere
 * else, and the configured window still governs a page nobody has touched since.
 */
export const THREAD_HIBERNATION_AGENT_GRACE_MS = 10 * 60 * 1000

/** The little a sleep decision needs to know about one tab. */
export interface HibernatableThreadTab {
  id: string
  url: string
  hibernated: boolean
  /** Last moment a person used this tab; the idle clock reads it. */
  lastUsedAt: number
}

/**
 * Whether a tab has a page worth releasing, right now.
 *
 * Three refusals: a tab already asleep has nothing left to release, a tab with no
 * address has no page at all (its empty state is the address field), and a page a
 * surface is displaying belongs to the person reading it, whatever any clock
 * says. `onScreen` is the app's answer about the native page, not the strip's, so
 * a page shown full screen or in the workspace panel is covered by the same rule.
 */
export function canSleepThreadTab(tab: HibernatableThreadTab, onScreen: boolean): boolean {
  if (tab.hibernated || tab.url === '') return false
  return !onScreen
}

/** What a sleep decision weighs, once the tab and the app's own state are known. */
export interface ThreadTabSleepCheck {
  tab: HibernatableThreadTab
  now: number
  /** The configured idle window, from the one hibernation setting. */
  windowMs: number
  /** When an agent last worked on this tab, or 0 when none has in this process. */
  agentUsedAt: number
  /** Whether a surface is displaying this page right now. */
  onScreen: boolean
}

/**
 * Whether this tab's page has been left alone long enough to release.
 *
 * The clock is whichever use is newer, the person's or the agent's, so an agent
 * operation keeps the page awake exactly as a click does. An agent's page also
 * earns `THREAD_HIBERNATION_AGENT_GRACE_MS` as a floor, because a model turn
 * between two calls is not the user leaving the page.
 */
export function isThreadTabIdlePastWindow(input: ThreadTabSleepCheck): boolean {
  if (!canSleepThreadTab(input.tab, input.onScreen)) return false
  const windowMs =
    input.agentUsedAt > 0
      ? Math.max(input.windowMs, THREAD_HIBERNATION_AGENT_GRACE_MS)
      : input.windowMs
  return input.now - Math.max(input.tab.lastUsedAt, input.agentUsedAt) >= windowMs
}
