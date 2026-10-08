/**
 * Project-relative locations for inline thread artifacts served over `appfile://`.
 *
 * Media the artifact pipeline renders inline (`src/main/chat/inline-artifact-service.ts`)
 * is served as `appfile://thread/<projectId>/<threadId>/<relativePath>?v=…` where the
 * encoded path is relative to the thread's workspace root. For project threads
 * that root is the project directory itself, so the encoded path is already the
 * project-relative path the file tree and citation resolver understand.
 *
 * The fullscreen previews and the file-part context menu gate their reveal
 * actions on `file://` URLs only, which hides them for every inline artifact.
 * These helpers map the serve URL back to the project-relative path so both
 * surfaces can reveal the file that is actually on disk. The scheme never
 * matters, only that the part resolves inside the project route.
 */

export interface ThreadArtifactLocation {
  projectId: string
  /** Absent for `appfile://project/…` URLs, which carry no thread. */
  threadId?: string
  /** Project-relative path, percent-decoded and without any query string. */
  relativePath: string
}

function decodeSegments(pathname: string): string[] | null {
  const segments: string[] = []
  for (const segment of pathname.split('/')) {
    if (!segment || segment === '.') continue
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === '..' || decoded.includes('/')) return null
    segments.push(decoded)
  }
  return segments
}

/** Parse an `appfile://thread/…` or `appfile://project/…` URL, or null. */
export function threadArtifactLocationForUrl(url: string): ThreadArtifactLocation | null {
  if (!url.startsWith('appfile://')) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const segments = decodeSegments(parsed.pathname)
  if (!segments) return null
  if (parsed.host === 'thread') {
    const [projectId, threadId, ...rest] = segments
    if (!projectId || !threadId || rest.length === 0) return null
    return { projectId, threadId, relativePath: rest.join('/') }
  }
  if (parsed.host === 'project') {
    const [projectId, ...rest] = segments
    if (!projectId || rest.length === 0) return null
    return { projectId, relativePath: rest.join('/') }
  }
  return null
}

/**
 * Project-relative path for a viewer URL that belongs to this thread, or null.
 * Thread URLs must name this project and thread; project URLs must name this
 * project. Anything else (attachments, standalone files, other threads) stays
 * on its existing path so no surface ever reveals a file it was not shown.
 */
export function threadArtifactRelativePath(
  url: string,
  projectId: string,
  threadId: string
): string | null {
  const location = threadArtifactLocationForUrl(url)
  if (!location || location.projectId !== projectId) return null
  if (location.threadId !== undefined && location.threadId !== threadId) return null
  return location.relativePath
}
