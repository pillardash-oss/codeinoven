import { session } from 'electron'
import type { BrowserWindow } from 'electron'
import { bootDependency, installFilePreviewProtocol } from '../editor/file-preview-protocol'
import type { ProjectFilesService } from '../editor/project-files-service'
import type { PrivilegedIpcValidator } from '../ipc/ipc-validation'
import { localDownloadName } from '../system/local-download-names'

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
 * media permission coverage. Downloads initiated from the renderer are denied,
 * because exports always use the native save dialog in the main process; a
 * `blob:` URL the trusted window itself created is the one allowed exception
 * (see the download guard below).
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

  // Downloads this app's own renderer starts are denied, because every export
  // it draws itself goes through the native save dialog in the main process.
  //
  // A `blob:` URL is the exception, and it has to be. Those bytes exist only in
  // the renderer's memory, so saving one is the only way they can ever reach the
  // disk, and the surface that asks for it is not always ours to draw: the media
  // controls behind an `<audio controls>` element carry their own Download item,
  // and denying its request made that item do nothing at all, with no dialog and
  // no file. A blob handed over by the trusted window is therefore allowed
  // through to Electron's default assistant, which prompts for a save path; the
  // name it suggests is the one the renderer registered for that URL.
  session.defaultSession.on('will-download', (event, item, webContents) => {
    const ownBlob =
      item.getURL().startsWith('blob:') && webContents === deps.getMainWindow()?.webContents
    if (!ownBlob) {
      event.preventDefault()
      return
    }
    item.setSaveDialogOptions({
      title: 'Save file',
      defaultPath: localDownloadName(item.getURL()) ?? item.getFilename()
    })
  })
}

export interface AppFilePreviewProtocolDeps {
  getProjectFiles: () => ProjectFilesService | null
  getScopedPathResolver: () => ((value: unknown) => Promise<string>) | null
  /** Whether the boot could still publish the resolver, so a request waits it out. */
  isBootPending: () => boolean
}

/**
 * Install the `appfile://` preview protocol before the renderer loads: the
 * packaged renderer requests preview images as soon as it hydrates, and if the
 * handler is not yet registered Chromium rejects those early requests with
 * `net::ERR_UNKNOWN_URL_SCHEME`, leaving file-tree images permanently broken.
 * The file service is resolved lazily from the post-paint boot.
 */
export function installAppFilePreviewProtocol(deps: AppFilePreviewProtocolDeps): void {
  // The scoped path resolver is published by the same post-paint boot as the
  // file service, so a preview of a file the user opened can arrive before it
  // exists. Waiting for it answers that request instead of failing it, which is
  // what left such an image broken until the next reload.
  const scopedPath = bootDependency(
    deps.getScopedPathResolver,
    'Scoped path resolution',
    deps.isBootPending
  )
  installFilePreviewProtocol(
    deps.getProjectFiles,
    (value) => scopedPath.read().then((resolve) => resolve(value)),
    deps.isBootPending
  )
}
