const SCHEME = 'appfile'

/** Build an `appfile://` URL for a project-relative file so the renderer can
 *  preview it with a real `src` (iframe/img) instead of a base64 IPC dump. */
export function projectFilePreviewUrl(projectId: string, relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/')
  return `${SCHEME}://project/${projectId}/${encoded}`
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
