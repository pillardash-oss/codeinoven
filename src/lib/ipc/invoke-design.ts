import type {
  AuthoredWorkKind,
  DesignOpenResult,
  DesignThumbnail,
  ThreadDesignState
} from './design'
import type { Contract } from './contract-helpers'

export const invokeDesignContract = {
  /**
   * Whether a thread is a design session, which design it last previewed, and
   * every design folder the project holds. Answers from persisted data, so a
   * restarted app can restore the coordinator and the design tab.
   */
  'design:state': {} as Contract<[projectId: string, threadId: string], ThreadDesignState>,
  /**
   * Which authored-work session each of these threads is in, so a thread row can carry
   * a design or video marker without asking once per row.
   *
   * A thread in neither session is absent from the answer rather than defaulted, so a
   * caller never has to guess whether an entry means "a session" or "a design".
   */
  'design:kinds': {} as Contract<
    [projectId: string, threadIds: string[]],
    Record<string, AuthoredWorkKind>
  >,
  /**
   * Serve a design folder and show it in this project and thread's browser tab.
   * With `reveal` the tab is brought to the user; without it the tab loads in
   * the background, which is how the coordinator gets a thumbnail without
   * stealing focus.
   */
  'design:open': {} as Contract<
    [projectId: string, threadId: string, directory: string, entry: string | null, reveal: boolean],
    DesignOpenResult
  >,
  /**
   * Capture the design as a small picture for the coordinator. Serves the
   * folder and loads it in the thread's tab when it is not already showing.
   */
  'design:thumbnail': {} as Contract<
    [projectId: string, threadId: string, directory: string, entry: string | null, width: number],
    DesignThumbnail
  >
}
