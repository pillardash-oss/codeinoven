import { toPosixPath } from '$shared/paths'

const SCHEME = 'appfile'

/** Build an `appfile://` URL for a project-relative file so the renderer can
 *  preview it with a real `src` (iframe/img) instead of a base64 IPC dump.
 *  When `chatThreadId` is set, the file resolves inside that chat thread's
 *  own `chats-artifacts/<threadId>` artifact directory instead of a project.
 *  `version`, when provided, is appended as a `?v=` query so a changed URL
 *  re-creates the preview element and re-reads the file from disk (the main
 *  process ignores the query). */
export function projectFilePreviewUrl(
  projectId: string,
  relativePath: string,
  chatThreadId?: string,
  version?: number
): string {
  const encoded = toPosixPath(relativePath)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  const base = chatThreadId
    ? `${SCHEME}://chat/${chatThreadId}/${encoded}`
    : `${SCHEME}://project/${projectId}/${encoded}`
  return version === undefined ? base : `${base}?v=${version}`
}

/** Build an `appfile://` URL for an out-of-project attachment stored in
 *  CodeInOven storage. `name` carries the original filename so the protocol
 *  handler can derive the correct Content-Type. */
export function attachmentPreviewUrl(
  projectId: string,
  attachmentId: string,
  name: string
): string {
  return `${SCHEME}://attachment/${projectId}/${attachmentId}?name=${encodeURIComponent(name)}`
}

/**
 * Build an `appfile://` URL for a standalone (OS-opened) file, so the
 * read-only viewer can preview images, PDFs, and media with a real `src`. The
 * main process resolves the absolute path through the same scoped-path
 * authorization privileged IPC uses, so only paths the user actually opened
 * (or picked in a dialog) can be served. `name` carries the basename because
 * the MIME type is derived from the extension. `version` re-creates the
 * preview element after an explicit reload.
 */
export function standaloneFilePreviewUrl(
  absolutePath: string,
  name: string,
  version?: number
): string {
  const base = `${SCHEME}://standalone/file?path=${encodeURIComponent(
    absolutePath
  )}&name=${encodeURIComponent(name)}`
  return version === undefined ? base : `${base}&v=${version}`
}
