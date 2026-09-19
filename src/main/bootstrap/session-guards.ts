import { session } from 'electron'
import type { BrowserWindow } from 'electron'
import { installFilePreviewProtocol } from '../editor/file-preview-protocol'
import type { ProjectFilesService } from '../editor/project-files-service'
import type { PrivilegedIpcValidator } from '../ipc/ipc-validation'

export interface RendererSessionGuardDeps {
  validator: PrivilegedIpcValidator
  getMainWindow: () => BrowserWindow | null
}

/**
 * Install the renderer's session-level guards before the window navigates.
 *
 * The trusted top-level renderer may capture microphone audio for local
 * dictation. Camera, subframes, foreign documents, and every unrelated
 * permission remain denied. Electron requires both handlers for complete
 * media permission coverage. Downloads initiated from the renderer are denied
 * outright; exports always use the native save dialog in the main process.
 */
export function installRendererSessionGuards(deps: RendererSessionGuardDeps): void {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const requestingUrl = details.requestingUrl ?? webContents?.getURL() ?? ''
    return (
      permission === 'media' &&
      details.mediaType === 'audio' &&
      details.isMainFrame &&
      webContents === deps.getMainWindow()?.webContents &&
      deps.validator.isTrustedNavigation(requestingUrl)
    )
  })
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
      const audioOnly =
        Array.isArray(mediaTypes) &&
        mediaTypes.length > 0 &&
        mediaTypes.every((mediaType) => mediaType === 'audio')
      callback(
        permission === 'media' &&
          audioOnly &&
          details.isMainFrame &&
          webContents === deps.getMainWindow()?.webContents &&
          deps.validator.isTrustedNavigation(details.requestingUrl)
      )
    }
  )

  // Deny all downloads initiated from the renderer; exports always use the
  // native save dialog in the main process.
  session.defaultSession.on('will-download', (event) => {
    event.preventDefault()
  })
}

export interface AppFilePreviewProtocolDeps {
  getProjectFiles: () => ProjectFilesService | null
  getScopedPathResolver: () => ((value: unknown) => Promise<string>) | null
}

/**
 * Install the `appfile://` preview protocol before the renderer loads: the
 * packaged renderer requests preview images as soon as it hydrates, and if the
 * handler is not yet registered Chromium rejects those early requests with
 * `net::ERR_UNKNOWN_URL_SCHEME`, leaving file-tree images permanently broken.
 * The file service is resolved lazily from the post-paint boot.
 */
export function installAppFilePreviewProtocol(deps: AppFilePreviewProtocolDeps): void {
  installFilePreviewProtocol(deps.getProjectFiles, (value) => {
    const resolveScopedPath = deps.getScopedPathResolver()
    if (!resolveScopedPath) throw new Error('Scoped path resolution is not ready')
    return resolveScopedPath(value)
  })
}
