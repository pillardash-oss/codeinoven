import type {
  AgentModelSelection,
  AgentRole,
  AppConfig,
  AppConfigPatch,
  AttachmentStorageScope,
  EditorId,
  EditorInfo,
  InstanceRole,
  ProjectTextFile
} from '../types'
import type { RendererLogEntry } from './logging'
import type { Contract } from './contract-helpers'

/** One file the user explicitly chooses to save from the renderer. */
export interface SaveFileInput {
  suggestedName: string
  contents: string
  filters?: { name: string; extensions: string[] }[]
}

export const invokeAppContract = {
  'config:get': {} as Contract<[], AppConfig>,
  'config:update': {} as Contract<[patch: AppConfigPatch], AppConfig>,
  'config:syncAgentRole': {} as Contract<
    [role: AgentRole, selection: AgentModelSelection],
    AppConfig
  >,
  'dialog:pickFolder': {} as Contract<[], string | null>,
  'dialog:pickCloneDestination': {} as Contract<[], string | null>,
  'clipboard:saveImage': {} as Contract<[scope: AttachmentStorageScope], string | null>,
  'clipboard:writeText': {} as Contract<[text: string], void>,
  'clipboard:readText': {} as Contract<[], string>,
  'dialog:pickFile': {} as Contract<[scope?: AttachmentStorageScope], string | null>,
  'dialog:saveFile': {} as Contract<[input: SaveFileInput], string | null>,
  'dialog:pickFiles': {} as Contract<[scope?: AttachmentStorageScope], string[]>,
  'dialog:pickImage': {} as Contract<[], string | null>,
  /** Store a picked appearance image (a browser tab, group, box, bookmark or
   *  sticky note icon) as an app-owned copy and answer with that copy's path and
   *  its data URL. A picked path is authorized for one process only, so it is
   *  never what an appearance record keeps. */
  'appearance:storeImage': {} as Contract<[sourcePath: string], { path: string; dataUrl: string }>,
  'diagnostics:export': {} as Contract<[], string | null>,
  'file:read': {} as Contract<[filePath: string], Uint8Array<ArrayBuffer> | null>,
  'file:readAsDataUrl': {} as Contract<[filePath: string], string | null>,
  'file:readDocumentPreview': {} as Contract<[filePath: string], string | null>,
  'editors:detect': {} as Contract<[], EditorInfo[]>,
  'editors:getPreferred': {} as Contract<[], EditorId>,
  'editors:setPreferred': {} as Contract<[editorId: EditorId], void>,
  /** Read a text file by absolute path. The path must be scoped (an OS-opened
   *  file or a user-selected path); standalone viewing uses this instead of the
   *  project-relative `projectFiles:read`. */
  'file:readText': {} as Contract<[filePath: string], ProjectTextFile | null>,
  /** Save text back to a file opened on its own through the operating system.
   *  Same scoped-path authorization as `file:readText`, and the same
   *  revision-checked atomic write as `projectFiles:save`, so an edit made in the
   *  standalone viewer can never clobber a change made elsewhere. */
  'file:writeText': {} as Contract<
    [filePath: string, content: string, expectedRevision: string],
    ProjectTextFile
  >,
  'pty:create': {} as Contract<
    [
      id: string,
      projectId: string,
      threadId: string,
      columns: number,
      rows: number,
      scopeBucketId?: string,
      /** Project-relative folder the shell must start in ('' is the root).
       *  Resolved and containment-checked against the scope root. */
      directory?: string
    ],
    { id: string; pid: number }
  >,
  'pty:createCommand': {} as Contract<
    [
      id: string,
      command: string,
      args: string[],
      columns: number,
      rows: number,
      /** Kill the session after this many ms of zero output/input (e.g. hung updates). */
      idleTimeoutMs?: number,
      environment?: Record<string, string>
    ],
    { id: string; pid: number }
  >,
  'pty:createAction': {} as Contract<
    [
      id: string,
      projectId: string,
      threadId: string,
      script: string,
      variables: Record<string, string>,
      columns: number,
      rows: number,
      scopeBucketId?: string
    ],
    { id: string; pid: number }
  >,
  'pty:destroy': {} as Contract<[id: string], void>,
  'shell:openExternal': {} as Contract<[url: string], void>,
  'shell:revealPath': {} as Contract<[path: string], boolean>,
  /** Reveal an existing absolute path (e.g. an agent-cited file outside the
   *  project root) in the OS file manager. Existence is checked; no content is
   *  read or opened. Returns false when the path does not exist. */
  'shell:revealExternalPath': {} as Contract<[path: string], boolean>,
  /** Resolve website favicons for a list of hostnames. Returns a data URL per host, or null when none exists. */
  'web:favicon': {} as Contract<[hostnames: string[]], Record<string, string | null>>,
  'app:confirmClose': {} as Contract<[], void>,
  /**
   * The renderer approved parking the window: it is torn down and the backend
   * keeps running in the menu bar so scheduled work still fires. Distinct from
   * `app:confirmClose`, which really quits the process.
   */
  'app:parkWindow': {} as Contract<[], void>,
  /**
   * Quit CodeInOven for real, bypassing background mode's park: the menu bar's
   * Quit item as a shortcut. The shutdown pipeline still runs, so a turn left in
   * flight is settled as a deliberate close rather than a crash.
   */
  'app:quitDirect': {} as Contract<[], void>,
  /** This process's role against the shared backend, for hydration on mount. */
  'app:instanceRole': {} as Contract<[], InstanceRole>,
  /**
   * Ask the process that owns scheduled work to bring its window forward. Used
   * by a secondary instance's "Open running instance" action. Returns false
   * when the owner could not be reached or already exited.
   */
  'app:openInstanceOwner': {} as Contract<[], boolean>,
  /**
   * A secondary takes over ownership of scheduled work from the current owner,
   * which steps down and shows the "running in another instance" notice
   * instead. The escape hatch when the elected owner is a stale or crashed
   * window. Returns false when the hand-over could not be written.
   */
  'app:transferInstanceControl': {} as Contract<[], boolean>,
  /** Resolves after post-paint feature IPC and harness services are registered. */
  'app:waitForFeatures': {} as Contract<[], void>,
  /**
   * Signalled by the renderer after its initial hydration completes so the main
   * process can timestamp the `renderer:hydrated` / `workspace:ready` startup
   * phases. Carries no payload.
   */
  'app:rendererReady': {} as Contract<[], void>,
  /**
   * Renderer forwards its own captured errors (uncaught exceptions, unhandled
   * rejections, console errors) to the main-process durable Logger. Fire and
   * forget; returns `void`.
   */
  'renderer:log': {} as Contract<[entry: RendererLogEntry], void>
}
