import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID, type Thread } from '$shared/types'
import type { MainView } from '$lib/stores/renderer-recovery'

/**
 * The three families of thread a content view can show.
 *
 * Every content view belongs to exactly one family, and a thread belongs to the
 * family of the container it lives in, so a view can never keep a thread from
 * another family selected (a chat shown in Projects, or a project thread shown
 * in Assistant).
 */
export type ContentThreadFamily = 'projects' | 'chats' | 'assistant'

/** The family a thread belongs to, by the project or hidden container it lives in. */
export function contentThreadFamily(thread: Pick<Thread, 'projectId'>): ContentThreadFamily {
  if (thread.projectId === ASSISTANT_SPACE_ID) return 'assistant'
  if (thread.projectId === INBOX_PROJECT_ID) return 'chats'
  return 'projects'
}

/**
 * The family a content view shows. Projects and Threads share one family:
 * Threads is the project threads' own timeline, so moving between the two keeps
 * the open thread. Takeover views (Settings, Scope) show no thread of their own,
 * so they return null and leave the current selection untouched.
 */
export function contentViewFamily(view: MainView): ContentThreadFamily | null {
  if (view === 'projects' || view === 'projects-scope' || view === 'threads') return 'projects'
  if (view === 'chats') return 'chats'
  if (view === 'assistant') return 'assistant'
  return null
}

/** What a content view should show once the shell lands on it. */
export type ContentViewThreadDecision =
  { kind: 'keep' } | { kind: 'open'; thread: Thread } | { kind: 'clear' }

export interface ContentViewThreadLookup {
  /** The thread the family was last showing, when it still exists. */
  remembered: (family: ContentThreadFamily) => Thread | null
  /** The most recently visited thread of the family, as a fallback. */
  recentOfFamily: (family: ContentThreadFamily) => Thread | null
}

/**
 * Which thread a content view shows once the shell switches to it.
 *
 * The open thread is kept when it already belongs to the view's family, so
 * Projects and Threads never drop the project thread the user is reading.
 * Otherwise the family's own remembered thread is restored, then the most
 * recent thread of that family, and only then does the view fall back to its
 * empty state. This is what lets Projects, Chats and Assistant each remember
 * their own open thread across a switch, instead of one global selection that
 * whichever view was visited last wins.
 */
export function decideContentViewThread(
  view: MainView,
  selectedThread: Thread | null,
  lookup: ContentViewThreadLookup
): ContentViewThreadDecision {
  const family = contentViewFamily(view)
  if (!family) return { kind: 'keep' }
  if (selectedThread && contentThreadFamily(selectedThread) === family) return { kind: 'keep' }
  const remembered = lookup.remembered(family)
  if (remembered) return { kind: 'open', thread: remembered }
  const recent = lookup.recentOfFamily(family)
  if (recent) return { kind: 'open', thread: recent }
  return { kind: 'clear' }
}
