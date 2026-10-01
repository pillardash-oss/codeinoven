import { toast } from 'svelte-sonner'
import type { OpenedPath, ProjectTextFile } from '$shared/types'
import type { CloseConfirmationFile } from '$shared/ipc-contract'
import { posixBasename } from '$shared/paths'
import { invoke } from '$lib/ipc.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'

/**
 * How the open files are surfaced: a docked floating panel (the default, so the
 * workspace and its threads stay usable) or the fullscreen reader/editor.
 */
export type StandaloneFilePresentation = 'docked' | 'fullscreen'

/** One file opened on its own, outside any project. */
export interface StandaloneFile {
  /** Absolute canonical path (the OS hand-off already resolved it). */
  path: string
  name: string
}

/**
 * Editable text state for one standalone file. Kept per path so switching tabs
 * never drops a draft and a file that is already loaded is never re-read.
 */
export interface StandaloneTextSession {
  /** The disk version the draft is based on; a save checks its revision first. */
  source: ProjectTextFile
  draft: string
  saving: boolean
  /** Why the last save failed (a conflict, a permission error), verbatim. */
  error: string | null
}

/**
 * Files the user opened through the operating system ("Open in CodeInOven"),
 * docked as a floating panel by default and openable full screen.
 *
 * Deliberately project-less: opening one file must not create a project or load
 * a file tree, so nothing about a repository is read, indexed, or kept in
 * memory beyond the single file being displayed. Saving goes through the
 * revision-checked `file:writeText` channel, which authorizes the path with the
 * same scoped-path resolver the project editor's saves and `file:readText` use
 * (project roots, user-selected files and directories, approved attachments),
 * and never with anything the renderer passes in as an already-safe path.
 * Idempotent by canonical path, so a repeated "Open in CodeInOven" (or a relayed
 * launch argument) focuses the file that is already open instead of stacking
 * another tab.
 */
class StandaloneFilesState {
  files = $state<StandaloneFile[]>([])
  activePath = $state<string | null>(null)
  /**
   * Whether the files are surfaced as the docked floating panel (default) or
   * fullscreen. Chosen per open, and reset to docked when the last file closes
   * so a fresh OS hand-off always starts docked.
   */
  presentation = $state<StandaloneFilePresentation>('docked')
  /** Whether the docked panel is collapsed into its dock chip. Only meaningful
   *  while the panel is docked; the fullscreen surface is never minimized. */
  minimized = $state(false)
  /** A file whose close is waiting on the unsaved-changes decision. Owned here
   *  because both the docked and the fullscreen surface ask the same question. */
  pendingClose = $state<{ path: string; name: string } | null>(null)
  #sessions = $state<Record<string, StandaloneTextSession>>({})

  get active(): StandaloneFile | null {
    const path = this.activePath
    if (!path) return null
    return this.files.find((file) => file.path === path) ?? null
  }

  get open(): boolean {
    return this.files.length > 0
  }

  /** The editable session for a file, or null while it is not loaded as text
   *  (binary previews, or a file that is still being read). */
  session(path: string): StandaloneTextSession | null {
    return this.#sessions[path] ?? null
  }

  /** Whether the file has edits that are not on disk yet. */
  isDirty(path: string): boolean {
    const session = this.#sessions[path]
    return session ? session.draft !== session.source.content : false
  }

  /**
   * Whether the on-screen file has edits that are not on disk yet. A minimized
   * panel is off screen, so it releases the save chord: the file is still open
   * and still saved by `saveAllUnsaved`, but Cmd/Ctrl+S belongs to whatever the
   * user is actually looking at. The save chord and the sidebar fold both key off
   * this, so the two can never both fire.
   */
  get activeHasUnsavedChanges(): boolean {
    if (this.minimized) return false
    const path = this.activePath
    return path ? this.isDirty(path) : false
  }

  /** Unsaved standalone files, shaped for the close-confirmation list. They
   *  carry no project id: they are open on their own. */
  getUnsavedFiles(): CloseConfirmationFile[] {
    return this.files
      .filter((file) => this.isDirty(file.path))
      .map((file) => ({ projectId: '', path: file.path }))
  }

  /** Add (or focus) a file, and show it. A file the user just opened is always
   *  brought to the front, so a collapsed panel is restored to show it. */
  show(path: string, name?: string): void {
    if (!path) return
    if (!this.files.some((file) => file.path === path)) {
      this.files = [...this.files, { path, name: name || posixBasename(path) || path }]
    }
    this.minimized = false
    this.activePath = path
  }

  activate(path: string): void {
    if (this.files.some((file) => file.path === path)) this.activePath = path
  }

  /** Collapse the docked panel into its dock chip. */
  minimize(): void {
    if (this.files.length === 0) return
    this.minimized = true
  }

  /** Bring the docked panel back from its chip. */
  restore(): void {
    this.minimized = false
  }

  /** Switch to the fullscreen reader/editor. */
  showFullscreen(): void {
    if (this.files.length === 0) return
    this.minimized = false
    this.presentation = 'fullscreen'
  }

  /** Return to the docked floating panel. */
  dock(): void {
    this.presentation = 'docked'
  }

  /** Ask to close one file, confirming first when it has unsaved edits. */
  requestClose(path: string): void {
    if (!this.isDirty(path)) {
      this.close(path)
      return
    }
    const file = this.files.find((candidate) => candidate.path === path)
    if (file) this.pendingClose = { path: file.path, name: file.name }
  }

  dismissClose(): void {
    this.pendingClose = null
  }

  /** Save the pending file and close it; on failure the file stays open so the
   *  error the pane renders can be acted on. */
  async saveAndClosePending(): Promise<void> {
    const target = this.pendingClose
    if (!target) return
    // A save already in flight: let it land rather than closing over it.
    if (this.#sessions[target.path]?.saving) return
    await this.save(target.path)
    if (this.isDirty(target.path)) {
      this.pendingClose = null
      toast.error(`${target.name} could not be saved`, {
        description: 'The file stayed open so you can review the error and retry.'
      })
      return
    }
    this.close(target.path)
    this.pendingClose = null
  }

  /** Close the pending file, dropping its unsaved draft. */
  discardPending(): void {
    const target = this.pendingClose
    if (!target) return
    this.close(target.path)
    this.pendingClose = null
  }

  /** Close one file; the next one becomes active, if any. The caller confirms
   *  first when the file has unsaved edits: closing drops the draft. */
  close(path: string): void {
    const index = this.files.findIndex((file) => file.path === path)
    if (index === -1) return
    const remaining = this.files.filter((file) => file.path !== path)
    this.files = remaining
    delete this.#sessions[path]
    if (this.pendingClose?.path === path) this.pendingClose = null
    if (remaining.length === 0) {
      // Nothing left to show: forget the surface choice so the next hand-off
      // starts from the docked default instead of a stale fullscreen. Nothing
      // is lost if a close was still pending; its file is already gone.
      this.activePath = null
      this.minimized = false
      this.presentation = 'docked'
      return
    }
    if (this.activePath !== path) return
    this.activePath = remaining[Math.min(index, remaining.length - 1)]?.path ?? null
  }

  /**
   * Read a file as editable text, replacing any session for it. Returns the
   * disk version, or null when the file is not text the app can edit.
   */
  async loadText(path: string): Promise<ProjectTextFile | null> {
    const file = await invoke('file:readText', path)
    if (!file) {
      delete this.#sessions[path]
      return null
    }
    this.#sessions[path] = { source: file, draft: file.content, saving: false, error: null }
    return file
  }

  updateDraft(path: string, text: string): void {
    const session = this.#sessions[path]
    if (!session) return
    session.draft = text
  }

  /** Re-read the disk version, dropping the draft. The caller confirms the
   *  discard before calling this when the file has unsaved edits. */
  async reload(path: string): Promise<void> {
    const session = this.#sessions[path]
    try {
      const file = await invoke('file:readText', path)
      if (!file) {
        if (session) session.error = 'This file can no longer be read from disk'
        return
      }
      if (session) {
        session.source = file
        session.draft = file.content
        session.error = null
        return
      }
      this.#sessions[path] = { source: file, draft: file.content, saving: false, error: null }
    } catch (error) {
      const message = ipcErrorMessage(error, 'The file could not be reloaded')
      if (session) session.error = message
    }
  }

  /** Save one file's draft. A revision conflict or a write failure is recorded
   *  on the session and shown by the pane instead of being thrown. */
  async save(path: string): Promise<void> {
    const session = this.#sessions[path]
    if (!session || session.saving) return
    if (session.draft === session.source.content) {
      // Nothing to save. A stale error from an earlier attempt must not keep the
      // banner up or make "Save and close" refuse a file that is already clean.
      session.error = null
      return
    }
    session.saving = true
    session.error = null
    const submittedDraft = session.draft
    try {
      const source = await invoke('file:writeText', path, submittedDraft, session.source.revision)
      session.source = source
      // A save that lands while the user kept typing must not discard the newer
      // keystrokes: the draft only follows the disk version when it is unchanged.
      if (session.draft === submittedDraft) session.draft = source.content
    } catch (error) {
      session.error = ipcErrorMessage(error, 'The file could not be saved')
    } finally {
      session.saving = false
    }
  }

  /** Save every standalone file with unsaved edits. Returns false when any save
   *  failed, so the caller (the quit flow) keeps the app open. */
  async saveAllUnsaved(): Promise<boolean> {
    let saved = true
    for (const file of [...this.files]) {
      if (!this.isDirty(file.path)) continue
      await this.save(file.path)
      const session = this.#sessions[file.path]
      if (session?.error) saved = false
    }
    return saved
  }
}

export const standaloneFiles = new StandaloneFilesState()

/** Show every file from one OS hand-off, keeping the last one in front. */
export function showOpenedFiles(paths: readonly OpenedPath[]): void {
  for (const opened of paths) {
    if (opened.kind === 'file') standaloneFiles.show(opened.path, opened.name)
  }
}
