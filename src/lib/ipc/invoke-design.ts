import type {
  AuthoredWorkKind,
  UpdateWorkDetails,
  UpdateWorkDetailsResult,
  DesignHistoryRestoreFileResult,
  DesignHistoryState,
  DesignOpenResult,
  DesignPageHistoryState,
  DesignRevisionCause,
  DesignScreenShot,
  DesignThumbnail,
  ProjectWorkState,
  ScreenCanvasState,
  ThreadDesignState
} from './design'
import type { WorkRoots } from '../design/work-roots'
import type { Contract } from './contract-helpers'
import type { DesignExportFormat, DesignExportResult } from '../design/design-export'
import type { DesignModelRanking } from '../design/design-review'
import type { VideoStudioDocument, VideoJob } from '../video/studio'
import type { VideoProjectManifest } from '../video/project'
import type { VideoPackagesState } from './video-packages'
import type { VideoFrameThumbnail } from '../video/frame-grid'

export const invokeDesignContract = {
  'video:frameStrip': {} as Contract<
    [projectId: string, threadId: string, directory: string, times: number[]],
    VideoFrameThumbnail[]
  >,
  /**
   * The composition's saved edits, plus the manifest a timeline is drawn from:
   * its duration is the ruler and its rate is the frame step, and neither of
   * those is part of the editable document.
   */
  'video:studio': {} as Contract<
    [projectId: string, threadId: string, directory: string],
    { document: VideoStudioDocument; revision: string; manifest: VideoProjectManifest | null }
  >,
  'video:save': {} as Contract<
    [
      projectId: string,
      threadId: string,
      directory: string,
      document: VideoStudioDocument,
      revision: string
    ],
    { document: VideoStudioDocument; revision: string; manifest: VideoProjectManifest | null }
  >,
  'video:jobs': {} as Contract<[projectId: string, threadId: string], VideoJob[]>,
  'video:cancel': {} as Contract<[projectId: string, threadId: string, jobId: string], void>,
  'video:export': {} as Contract<[projectId: string, threadId: string, directory: string], unknown>,
  /**
   * The export one composition already has, as a project-relative path, or null
   * when it has never been exported.
   *
   * Read rather than remembered: the board asks this for the folder in front, so
   * an export made in another thread of the same project, or before a restart,
   * still answers for the composition that produced it.
   */
  'video:latestExport': {} as Contract<
    [projectId: string, threadId: string, directory: string],
    string | null
  >,
  /**
   * A waveform picture for one audio source's used range, as a data URL.
   *
   * A timeline draws one band per audio track, and a band wants a picture of the
   * sound rather than its samples: the app cannot decode the file itself (the
   * preview origin sends no CORS header), so ffmpeg draws a bounded 1200x240
   * picture and the band is an image. Null means the source has no audio to
   * draw, which is a plain band rather than a failure.
   */
  'video:waveform': {} as Contract<
    [
      projectId: string,
      threadId: string,
      directory: string,
      source: string,
      offset: number,
      duration: number
    ],
    string | null
  >,
  /**
   * The optional video inference pack the GPU background-removal operation
   * needs. It installs at runtime into the app's config folder, so the shipped
   * installer never carries the heavy matting stack.
   */
  'video:packages:state': {} as Contract<[], VideoPackagesState>,
  'video:packages:install': {} as Contract<[], void>,
  'video:packages:remove': {} as Contract<[], void>,
  'video:packages:cancel': {} as Contract<[], boolean>,
  'design:rankings': {} as Contract<[startAt: number, endAt: number], DesignModelRanking[]>,
  'design:export': {} as Contract<
    [
      projectId: string,
      threadId: string,
      directory: string,
      entry: string | null,
      format: DesignExportFormat
    ],
    DesignExportResult
  >,
  /**
   * Whether a thread is a design session, which design it last previewed, and
   * every design folder the project holds. Answers from persisted data, so a
   * restarted app can restore the coordinator and the design tab.
   */
  'design:state': {} as Contract<[projectId: string, threadId: string], ThreadDesignState>,
  /**
   * Serve a design folder or composition and show it.
   *
   * A design's screen opens in a tab of its own, so clicking one canvas never
   * replaces another canvas's tab: the screen's own tab is navigated when it
   * exists and opened when it does not. `reveal` brings that tab to the user;
   * without it the page loads in the background. A composition opens in the video
   * board's own view, which is a registered tab that never enters the tab strip,
   * so the board can play and edit it without the user opening the browser.
   */
  'design:open': {} as Contract<
    [
      projectId: string,
      threadId: string,
      directory: string,
      entry: string | null,
      reveal: boolean,
      kind?: AuthoredWorkKind
    ],
    DesignOpenResult
  >,
  /**
   * Capture the design as a small picture for the coordinator. Serves the
   * folder and loads it in the thread's tab when it is not already showing.
   *
   * `kind` is the project board's override: it opens a kind the thread is not in
   * without recording that thread as being in it.
   */
  'design:thumbnail': {} as Contract<
    [
      projectId: string,
      threadId: string,
      directory: string,
      entry: string | null,
      width: number,
      kind?: AuthoredWorkKind
    ],
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
   * What one design folder's Screen Canvas is made of, as the board reads it.
   *
   * The canvas belongs to the app and is generated from the folder on every
   * request, so this is the folder's screens in canvas order, the states the
   * design declares but has not built, and anything its metadata names that no
   * longer exists. Nothing here can fall behind the design, because the folder is
   * the only source.
   */
  'design:canvas': {} as Contract<
    [projectId: string, threadId: string, directory: string],
    ScreenCanvasState | null
  >,
  /**
   * The folders designs and videos are written into for this project.
   *
   * Read straight after a save, because the board that changed one has to name
   * the folder the next design will land in. It is the project's own record, or
   * the app default when the project never changed it: there is no app-wide value
   * behind it.
   */
  'design:workRoots': {} as Contract<[projectId?: string], WorkRoots>,
  'design:removeMissing': {} as Contract<
    [projectId: string, threadId: string, directory: string],
    void
  >,
  'design:updateDetails': {} as Contract<
    [projectId: string, threadId: string, details: UpdateWorkDetails],
    UpdateWorkDetailsResult
  >,
  /**
   * One design or composition folder's history, captured up to the present.
   *
   * Reading captures first: a change the app has not seen yet becomes a revision
   * before the timeline is answered, so opening History is enough to make the
   * current state a point the user can return to. `cause` says who is asking, so a
   * revision the app takes after an agent turn is not labelled as a user edit.
   */
  'design:history': {} as Contract<
    [projectId: string, threadId: string, directory: string, cause: DesignRevisionCause],
    DesignHistoryState
  >,
  /**
   * Move a folder to one point in its history, which is what Undo, Redo, and
   * clicking a revision all do. Returns the history as it stands after the move, so
   * the board never has to guess where the cursor landed.
   */
  'design:historyRestore': {} as Contract<
    [projectId: string, threadId: string, directory: string, revisionId: string],
    DesignHistoryState
  >,
  /**
   * One page's own line through the history, so the user can undo just that page.
   *
   * The states are the distinct contents the file held, read from the folder's
   * revisions, so stepping between two neighbours rewrites one file and leaves the
   * rest of the design alone.
   */
  'design:historyPage': {} as Contract<
    [projectId: string, threadId: string, directory: string, path: string],
    DesignPageHistoryState
  >,
  /**
   * Move one page to one point in its own history, which is what a page-scoped
   * Undo and Redo do. Answers with the folder's history and the page's line after
   * the move, so the board redraws the design and the timeline in one round trip.
   */
  'design:historyRestoreFile': {} as Contract<
    [projectId: string, threadId: string, directory: string, path: string, revisionId: string],
    DesignHistoryRestoreFileResult
  >,
  /**
   * Every design and composition folder one project holds, by kind.
   *
   * Asked by the right rail before any thread is chosen, so the project-level
   * design and video entries are there whether or not a session is open and
   * whether or not the thread on screen has anything to do with the work. The
   * two roots are read straight, so this needs no thread and no session.
   */
  /**
   * Every design and composition a scope holds, by kind.
   *
   * `threadId` is what names the workspace of a conversation that is not a
   * project: an assistant task, a chat and a browser tab each write into their own
   * directory, and the container id alone cannot say which one. A project answers
   * without it.
   */
  'design:projectWork': {} as Contract<[projectId: string, threadId?: string], ProjectWorkState>
}
