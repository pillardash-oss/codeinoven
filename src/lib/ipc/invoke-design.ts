import type {
  DesignOpenResult,
  DesignScreenShot,
  DesignThumbnail,
  ScreenCanvasState,
  ThreadDesignState,
  WorkRootState
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
   * Serve a design folder or composition and show it in the in-app browser.
   *
   * A design's screen opens in a tab of its own, so clicking one canvas never
   * replaces another canvas's tab: the screen's own tab is navigated when it
   * exists and opened when it does not. `reveal` brings that tab to the user;
   * without it the page loads in the background. A composition keeps the
   * thread's single tab, because its board holds one canvas.
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
   * Every screen of one design folder, each with a picture of it.
   *
   * A design holds a page per screen, so the board shows them together rather
   * than the one folder it has selected. The pictures are taken by the app, one
   * screen at a time, and one that has not changed since it was last rendered is
   * answered from what was captured then; `force` asks for all of them again.
   */
  'design:screens': {} as Contract<
    [projectId: string, threadId: string, directory: string, width: number, force: boolean],
    DesignScreenShot[]
  >,
  /**
   * Whether one design folder has a Screen Canvas, what it frames, and which of
   * its screens are missing from it or newer than it.
   *
   * The board asks before it offers a canvas: a design without one gets "Create
   * Screen Canvas", and one whose canvas is missing a screen or older than one
   * gets "Update Screen Canvas", with the reason it does. Answered from the
   * folder's own file, so it stays true across a restart and an edit outside the
   * app.
   */
  'design:canvas': {} as Contract<
    [projectId: string, threadId: string, directory: string],
    ScreenCanvasState | null
  >,
  /**
   * The folders designs and videos are written into, and what the last change
   * moved. Read straight after a save, because both surfaces that change a root
   * have to report what the move did with the work already on disk.
   */
  'design:workRootState': {} as Contract<[], WorkRootState>
}
