/**
 * Serving a conversation's own files so the in-app browser can open them.
 *
 * The browser only navigates http(s) (see `validateBrowserUrl`), and a chat's
 * workspace has no server behind it: a page the chat wrote had no URL at all,
 * so "open your page and check it" was impossible there even though the browser
 * itself is available to every conversation. The app already owns a loopback
 * static server for design and video previews; this hands the same server the
 * conversation's mount root, which is what a chat, an assistant and a project
 * thread all have.
 *
 * Path handling is pure and separate from the services so it can be tested
 * without a server: every path is relative to the mount root, and anything that
 * escapes it is refused rather than served.
 */
export interface WorkspacePreviewDeps {
  /** The mount root of this conversation: a project root, or a thread workspace. */
  resolveMountRoot(projectId: string, scopeBucketId?: string, threadId?: string): Promise<string>
  /** Serve one directory on its own loopback origin. */
  openPreview(root: string): Promise<{ url: string }>
}

export interface WorkspacePreviewRequest {
  projectId: string
  threadId: string
  /** A file or folder inside the mount root. Absent serves the root itself. */
  path?: string
}

export interface WorkspacePreviewResult {
  url: string
  /** The root that is being served, for a report that has to be exact. */
  root: string
  /** The path appended to the origin, or '' for the root itself. */
  path: string
}

/** Join one relative path onto a preview origin, refusing anything that escapes it. */
export function workspacePreviewUrl(origin: string, relativePath: string): string | null {
  const cleaned = relativePath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  if (cleaned.some((segment) => segment === '..')) return null
  if (cleaned.some((segment) => segment.includes('\0'))) return null
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin
  if (cleaned.length === 0) return base
  return `${base}/${cleaned.map((segment) => encodeURIComponent(segment)).join('/')}`
}

export class BrowserServiceWorkspacePreview {
  private deps: WorkspacePreviewDeps | null = null

  /**
   * Installed by the boot once the file and preview services exist.
   *
   * The browser service is created long before them, so this is a seam rather
   * than a constructor argument: without it the operation reports that preview
   * is unavailable instead of failing in a way an agent would read as "no
   * server".
   */
  attach(deps: WorkspacePreviewDeps): void {
    this.deps = deps
  }

  get available(): boolean {
    return this.deps !== null
  }

  async serve(request: WorkspacePreviewRequest): Promise<WorkspacePreviewResult> {
    const deps = this.deps
    if (!deps) {
      throw new Error(
        'Workspace preview is unavailable in this window, so there is no URL to open. Report this instead of starting a server of your own.'
      )
    }
    const root = await deps.resolveMountRoot(request.projectId, undefined, request.threadId)
    const registration = await deps.openPreview(root)
    const path = request.path?.trim() ?? ''
    const url = workspacePreviewUrl(registration.url, path)
    if (url === null) {
      throw new Error('A preview path must stay inside this conversation’s own folder.')
    }
    return { url, root, path }
  }
}
