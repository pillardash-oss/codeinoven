import type { OpenedPath } from '$shared/types'
import { posixBasename } from '$shared/paths'

/** One file opened on its own, outside any project. */
export interface StandaloneFile {
  /** Absolute canonical path (the OS hand-off already resolved it). */
  path: string
  name: string
}

/**
 * Files the user opened through the operating system, viewed read-only in the
 * fullscreen standalone viewer.
 *
 * Deliberately project-less: opening one file must not create a project or load
 * a file tree, so nothing about a repository is read, indexed, or kept in
 * memory beyond the single file being displayed. Idempotent by canonical path,
 * so a repeated "Open in CodeInOven" (or a relayed launch argument) focuses the
 * file that is already open instead of stacking another tab.
 */
class StandaloneFilesState {
  files = $state<StandaloneFile[]>([])
  activePath = $state<string | null>(null)

  get active(): StandaloneFile | null {
    const path = this.activePath
    if (!path) return null
    return this.files.find((file) => file.path === path) ?? null
  }

  get open(): boolean {
    return this.files.length > 0
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

  /** Close one file; the next one becomes active, if any. */
  close(path: string): void {
    const index = this.files.findIndex((file) => file.path === path)
    if (index === -1) return
    const remaining = this.files.filter((file) => file.path !== path)
    this.files = remaining
    if (this.activePath !== path) return
    this.activePath = remaining[Math.min(index, remaining.length - 1)]?.path ?? null
  }

  closeActive(): void {
    if (this.activePath) this.close(this.activePath)
  }

  closeAll(): void {
    this.files = []
    this.activePath = null
  }
}

export const standaloneFiles = new StandaloneFilesState()

/** Show every file from one OS hand-off, keeping the last one in front. */
export function showOpenedFiles(paths: readonly OpenedPath[]): void {
  for (const opened of paths) {
    if (opened.kind === 'file') standaloneFiles.show(opened.path, opened.name)
  }
}
