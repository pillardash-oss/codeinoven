import type { DesignOpenResult, DesignThumbnail, ThreadDesignState, WorkRootState } from './design'
import type { Contract } from './contract-helpers'

export const invokeDesignContract = {
  /**
   * Whether a thread is a design session, which design it last previewed, and
   * every design folder the project holds. Answers from persisted data, so a
   * restarted app can restore the coordinator and the design tab.
   */
  'design:state': {} as Contract<[projectId: string, threadId: string], ThreadDesignState>,
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
  >,
  /**
   * The folders designs and videos are written into, and what the last change
   * moved. Read straight after a save, because both surfaces that change a root
   * have to report what the move did with the work already on disk.
   */
  'design:workRootState': {} as Contract<[], WorkRootState>
}
