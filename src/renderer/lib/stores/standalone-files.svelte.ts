import type { OpenedPath, ProjectTextFile } from '$shared/types'
import type { CloseConfirmationFile } from '$shared/ipc-contract'
import { posixBasename } from '$shared/paths'
import { invoke } from '$lib/ipc.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'

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
 * viewed and edited in the fullscreen standalone viewer.
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
   * Whether the file in front has edits that are not on disk yet. The save chord
   * and the sidebar fold both key off this, so the two can never both fire: the
   * global handler defers to the pane's save whenever the active file is dirty.
   */
  get activeHasUnsavedChanges(): boolean {
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

  /** Add (or focus) a file, and show it. */
  show(path: string, name?: string): void {
    if (!path) return
    if (!this.files.some((file) => file.path === path)) {
      this.files = [...this.files, { path, name: name || posixBasename(path) || path }]
    }
    this.activePath = path
  }

  activate(path: string): void {
    if (this.files.some((file) => file.path === path)) this.activePath = path
  }

  /** Close one file; the next one becomes active, if any. The caller confirms
   *  first when the file has unsaved edits: closing drops the draft. */
  close(path: string): void {
    const index = this.files.findIndex((file) => file.path === path)
    if (index === -1) return
    const remaining = this.files.filter((file) => file.path !== path)
    this.files = remaining
    delete this.#sessions[path]
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
