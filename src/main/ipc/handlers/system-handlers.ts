import { app, dialog, shell, clipboard, BrowserWindow, nativeImage } from 'electron'
import { lstat, readFile, writeFile, mkdir } from 'fs/promises'
import { release } from 'os'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import { APP_NAME, APP_SLUG } from '../../../lib/brand'
import { atomicWrite } from '../../../lib/utils'
import { Logger } from '../../system/logger'
import { resolveFavicons } from '../../editor/favicon-service'
import { resolveAvatars } from '../../git/github-avatars'
import { retainTemporaryAttachment } from '../../editor/temporary-attachment-retention'
import { readDocumentPreviewHtml } from '../../drivers/document-attachment'
import {
  isMissingScopedPathError,
  validateFaviconHostnames,
  validateGitHubLogins
} from '../ipc-validation'
import { isMissingFilesystemError, requireString, validateAttachmentStorageScope } from './shared'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

export function registerSystemHandlers(ctx: IpcHandlerContext): void {
  const {
    storage,
    projectFilesService,
    diagnosticsService,
    privilegedIpc,
    privileged,
    attachmentStorageDirectory
  } = ctx

  // ─── System dialogs ────────────────────────────────────────────────────────
  ipcMain.handle('dialog:pickFolder', async () => {
    try {
      // Always resolve a parent window so the sheet attaches and comes to the front.
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()

      // Open at the last folder the user picked, instead of the OS default (Downloads).
      const config = await storage.getConfig()
      const options: Electron.OpenDialogOptions = {
        title: 'Select Project Folder',
        properties: ['openDirectory', 'createDirectory'],
        ...(config.lastFolderDialogPath ? { defaultPath: config.lastFolderDialogPath } : {})
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null

      // Remember the chosen folder for next time and record it as a
      // user-approved scope for reveal/preview operations.
      config.lastFolderDialogPath = result.filePaths[0]
      await privilegedIpc.registerUserSelectedRoot(result.filePaths[0])
      await storage.saveConfig(config)

      return result.filePaths[0]
    } catch (error) {
      Logger.error('dialog:pickFolder failed:', error)
      return null
    }
  })

  ipcMain.handle('clipboard:writeText', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string')
    clipboard.writeText(text)
  })

  ipcMain.handle('clipboard:readText', () => clipboard.readText())

  ipcMain.handle(
    'attachment:saveText',
    async (_event, rawScope: unknown, rawText: unknown, rawExistingPath: unknown) => {
      const scope = validateAttachmentStorageScope(rawScope)
      if (typeof rawText !== 'string' || rawText.trim().length === 0) {
        throw new TypeError('Text attachment must be a non-empty string')
      }
      const text = rawText

      const directory = await attachmentStorageDirectory(scope)
      await mkdir(directory, { recursive: true })
      let targetPath: string
      if (rawExistingPath === undefined) {
        targetPath = join(directory, `pasted-${randomUUID()}.txt`)
      } else {
        if (typeof rawExistingPath !== 'string') {
          throw new TypeError('Existing text attachment path must be a string')
        }
        targetPath = resolve(rawExistingPath)
        if (
          resolve(dirname(targetPath)) !== resolve(directory) ||
          !/^pasted-[0-9a-f-]+\.txt$/u.test(basename(targetPath))
        ) {
          throw new TypeError('Existing text attachment path is outside this composer')
        }
      }

      await atomicWrite(targetPath, text)
      await privilegedIpc.registerUserSelectedFile(targetPath)
      return targetPath
    }
  )

  ipcMain.handle('clipboard:saveImage', async (_event, rawScope: unknown) => {
    try {
      const scope = validateAttachmentStorageScope(rawScope)
      const items = await clipboard.read()
      const imageItem = items.find((item) => item.types.some((type) => type.startsWith('image/')))
      const imageType = imageItem?.types.find((type) => type.startsWith('image/'))
      if (!imageItem || !imageType) return null
      const blob = await imageItem.getType(imageType)
      if (!(blob instanceof Blob)) return null
      const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()))
      if (image.isEmpty()) return null
      const tempDir = await attachmentStorageDirectory(scope)
      await mkdir(tempDir, { recursive: true })
      const tempPath = join(tempDir, `pasted-${randomUUID()}.png`)
      await writeFile(tempPath, image.toPNG(), { flag: 'wx', mode: 0o600 })
      await privilegedIpc.registerUserSelectedFile(tempPath)
      return tempPath
    } catch (error) {
      Logger.error('clipboard:saveImage failed:', error)
      return null
    }
  })

  ipcMain.handle('dialog:pickFile', async (_event, rawScope: unknown) => {
    try {
      const scope = rawScope === undefined ? null : validateAttachmentStorageScope(rawScope)
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()

      const config = await storage.getConfig()
      const options: Electron.OpenDialogOptions = {
        title: 'Attach File',
        defaultPath: config.lastAttachmentDialogPath,
        properties: ['openFile'],
        filters: [
          { name: 'All Files', extensions: ['*'] },
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']
          },
          {
            name: 'Documents',
            extensions: [
              'pdf',
              'doc',
              'docx',
              'odt',
              'xls',
              'xlsx',
              'ppt',
              'pptx',
              'txt',
              'csv',
              'md',
              'json',
              'xml',
              'yaml',
              'yml'
            ]
          },
          { name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] },
          { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] },
          { name: 'Archives', extensions: ['zip', 'tar', 'gz', '7z', 'rar'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      const selectedPath = result.filePaths[0]
      config.lastAttachmentDialogPath = dirname(selectedPath)
      const retainedPath = scope
        ? await retainTemporaryAttachment(selectedPath, await attachmentStorageDirectory(scope))
        : selectedPath
      await privilegedIpc.registerUserSelectedFile(retainedPath)
      await storage.saveConfig(config)
      return retainedPath
    } catch (error) {
      Logger.error('dialog:pickFile failed:', error)
      return null
    }
  })

  ipcMain.handle('dialog:pickFiles', async (_event, rawScope: unknown) => {
    try {
      const scope = rawScope === undefined ? null : validateAttachmentStorageScope(rawScope)
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()

      const config = await storage.getConfig()
      const options: Electron.OpenDialogOptions = {
        title: 'Attach Files',
        defaultPath: config.lastAttachmentDialogPath,
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'All Files', extensions: ['*'] },
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']
          },
          {
            name: 'Documents',
            extensions: [
              'pdf',
              'doc',
              'docx',
              'odt',
              'xls',
              'xlsx',
              'ppt',
              'pptx',
              'txt',
              'csv',
              'md',
              'json',
              'xml',
              'yaml',
              'yml'
            ]
          },
          { name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] },
          { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] },
          { name: 'Archives', extensions: ['zip', 'tar', 'gz', '7z', 'rar'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return []

      config.lastAttachmentDialogPath = dirname(result.filePaths[0])
      const attachmentDirectory = scope ? await attachmentStorageDirectory(scope) : null
      const retainedPaths: string[] = []
      for (const selectedPath of result.filePaths) {
        const retainedPath = attachmentDirectory
          ? await retainTemporaryAttachment(selectedPath, attachmentDirectory)
          : selectedPath
        await privilegedIpc.registerUserSelectedFile(retainedPath)
        retainedPaths.push(retainedPath)
      }
      await storage.saveConfig(config)
      return retainedPaths
    } catch (error) {
      Logger.error('dialog:pickFiles failed:', error)
      return []
    }
  })

  ipcMain.handle('dialog:pickImage', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()

      const options: Electron.OpenDialogOptions = {
        title: 'Select Project Icon',
        properties: ['openFile'],
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp']
          }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      await privilegedIpc.registerUserSelectedFile(result.filePaths[0])
      return result.filePaths[0]
    } catch (error) {
      Logger.error('dialog:pickImage failed:', error)
      return null
    }
  })

  privileged('shell:openExternal', (_event, url: unknown) => {
    try {
      const safeUrl = privilegedIpc.validateExternalUrl(url)
      void shell.openExternal(safeUrl)
    } catch (error) {
      Logger.error('shell:openExternal rejected unsafe URL:', error)
    }
  })

  // Resolve website favicons for external links. Hostnames are validated at the
  // IPC boundary; data URLs returned by the resolver are image content only.
  ipcMain.handle('web:favicon', async (_event, rawHostnames: unknown) => {
    const hostnames = validateFaviconHostnames(rawHostnames)
    return resolveFavicons(hostnames)
  })

  // Avatars for the logins a pull request conversation names. Same reason as the
  // favicons above: the renderer's `img-src` allows `data:` and nothing remote, so
  // the picture is downloaded here and handed over inlined.
  ipcMain.handle('github:avatars', async (_event, rawLogins: unknown) => {
    const logins = validateGitHubLogins(rawLogins)
    return resolveAvatars(logins)
  })

  // Reveal a chat artifact (uploaded or agent-created file) in the system file
  // manager. The path must resolve inside a registered project, the config root,
  // or a user-selected scope.
  privileged('shell:revealPath', async (_event, path: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(path)
      shell.showItemInFolder(safePath)
      return true
    } catch (error) {
      if (isMissingScopedPathError(error) || isMissingFilesystemError(error)) return false
      Logger.error('shell:revealPath rejected out-of-scope path:', error)
      return false
    }
  })

  // Reveal an agent-cited file that lives outside every project root in the OS
  // file manager. Reveal-only: the path must be an existing absolute path to a
  // regular file or directory (symlinks are rejected) and no content is ever
  // read or opened, so no scope grant is needed.
  privileged('shell:revealExternalPath', async (_event, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0 || path.length > 16_384) return false
    if (path.includes('\0') || !isAbsolute(path)) return false
    try {
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) return false
      shell.showItemInFolder(path)
      return true
    } catch {
      return false
    }
  })

  privileged('storage:openDataDirectory', async () => {
    const error = await shell.openPath(storage.resolve(''))
    if (!error) return true

    Logger.error('Failed to open the data directory:', error)
    return false
  })

  // Read a file from disk and return it as a data URL   used for local previews
  // without persisting anything to project storage. Only scoped paths are read.
  const MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf'
  }

  // Read a local file into bytes for renderer-side media previews. The preload
  // no longer reads files directly; it delegates here so the path can be
  // constrained to registered project, config-root, or user-selected scopes.
  // Read a pasted-file source for the Sound Playground's read-aloud section:
  // plain text files directly, and rich documents (PDF, Word, PowerPoint, Excel,
  // OpenDocument, RTF, EPUB) through the `@firecrawl/anydoc` Rust library
  // fully local, no network, OCR never invoked. Only scoped paths (e.g. a file
  // the user just picked from the system dialog) are read.
  // Text is capped below the prepared-playback text limit.
  const PLAYGROUND_TEXT_EXTENSIONS = new Set([
    'txt',
    'md',
    'markdown',
    'log',
    'json',
    'jsonc',
    'csv',
    'tsv',
    'yml',
    'yaml',
    'toml',
    'xml',
    'html',
    'htm',
    'css',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'ts',
    'tsx',
    'py',
    'sh',
    'sql',
    'srt',
    'vtt'
  ])
  const PLAYGROUND_DOCUMENT_EXTENSIONS = new Set([
    'pdf',
    'docx',
    'doc',
    'odt',
    'rtf',
    'epub',
    'pptx',
    'xlsx',
    'xls',
    'ods'
  ])
  const MAX_PLAYGROUND_TEXT_CHARS = 900_000
  privileged('speech:playgroundReadText', async (_event, rawPath: unknown) => {
    try {
      if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 4_096) {
        throw new RangeError('The file path is invalid.')
      }
      const safePath = await privilegedIpc.resolveScopedPath(rawPath)
      const extension = extname(safePath).toLowerCase().replace(/^\./u, '')
      const fileName = basename(safePath)
      let text: string
      if (PLAYGROUND_DOCUMENT_EXTENSIONS.has(extension)) {
        const bytes = await readFile(safePath)
        const { toMarkdownBytes, formatFromExtension } = await import('@firecrawl/anydoc')
        const format = formatFromExtension(extension)
        try {
          text = await toMarkdownBytes(bytes, format)
        } catch (parseError) {
          if (
            extension === 'pdf' &&
            parseError instanceof Error &&
            parseError.message.includes('NeedsOcr')
          ) {
            throw new RangeError(
              'This PDF appears to be scanned   no local OCR is performed in the playground.',
              { cause: parseError }
            )
          }
          throw parseError
        }
        // Strip Markdown emphasis/heading markup so the TTS voice does not
        // read out syntax characters from the converted document.
        text = text
          .replace(/^#{1,6}\s+/gmu, '')
          .replace(/[*_~`]+/gu, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
          .replace(/<[^>]+>/gu, '')
      } else {
        if (!PLAYGROUND_TEXT_EXTENSIONS.has(extension)) {
          throw new RangeError(`Unsupported file type ".${extension}".`)
        }
        text = await readFile(safePath, 'utf8')
      }
      text = text.replace(/\r\n?/gu, '\n').trimEnd()
      if (text.trim().length === 0) throw new RangeError('The file contains no readable text.')
      let truncated = false
      if (text.length > MAX_PLAYGROUND_TEXT_CHARS) {
        text = text.slice(0, MAX_PLAYGROUND_TEXT_CHARS)
        truncated = true
      }
      return { text, fileName, truncated }
    } catch (error) {
      if (isMissingScopedPathError(error) || isMissingFilesystemError(error)) return null
      Logger.error('speech:playgroundReadText rejected path:', error)
      return null
    }
  })

  privileged('file:readText', async (_event, filePath: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(filePath)
      return await projectFilesService.readAbsoluteText(safePath)
    } catch (error) {
      if (isMissingScopedPathError(error) || isMissingFilesystemError(error)) return null
      Logger.error('file:readText rejected or failed:', error)
      return null
    }
  })

  // Save an edit made to a standalone file (one the OS handed over or the user
  // picked in a dialog). Authorization is the same scoped-path check the read
  // uses; the write itself is revision-checked and atomic, so a file that changed
  // on disk since it was read is never clobbered. Errors are surfaced (unlike the
  // read, which can only fail by showing nothing) because the editor has to tell
  // the user why their save did not land.
  privileged(
    'file:writeText',
    async (_event, filePath: unknown, content: unknown, expectedRevision: unknown) => {
      const revision = requireString(expectedRevision, 'File revision')
      if (!/^[a-f0-9]{64}$/u.test(revision)) {
        throw new TypeError('File revision must be a SHA-256 digest')
      }
      const safePath = await privilegedIpc.resolveScopedPath(filePath)
      return projectFilesService.writeAbsoluteText(
        safePath,
        requireString(content, 'File content', true),
        revision
      )
    }
  )

  privileged('file:read', async (_event, filePath: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(filePath)
      const buffer = await readFile(safePath)
      return new Uint8Array(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      )
    } catch (error) {
      if (isMissingScopedPathError(error) || isMissingFilesystemError(error)) return null
      Logger.error('file:read rejected out-of-scope path:', error)
      return null
    }
  })

  privileged('file:readAsDataUrl', async (_event, filePath: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(filePath)
      const ext = extname(safePath).toLowerCase()
      const mime = MIME_MAP[ext] ?? 'application/octet-stream'
      const buffer = await readFile(safePath)
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch (error) {
      if (isMissingScopedPathError(error) || isMissingFilesystemError(error)) return null
      Logger.error('file:readAsDataUrl rejected out-of-scope path:', error)
      return null
    }
  })

  // Convert a scoped document attachment (DOCX, legacy DOC, ODT, PPTX) to
  // bounded semantic HTML on demand. The renderer sanitizes and isolates the
  // result before displaying it.
  privileged('file:readDocumentPreview', async (_event, filePath: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(filePath)
      const extension = extname(safePath).toLowerCase().replace(/^\./u, '')
      const mimeByExtension: Record<string, string> = {
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        doc: 'application/msword',
        odt: 'application/vnd.oasis.opendocument.text',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xls: 'application/vnd.ms-excel',
        ods: 'application/vnd.oasis.opendocument.spreadsheet',
        csv: 'text/csv',
        tsv: 'text/tab-separated-values'
      }
      const mime = mimeByExtension[extension]
      if (!mime) return null
      return readDocumentPreviewHtml({
        mime,
        url: safePath,
        filename: basename(safePath)
      })
    } catch (error) {
      if (isMissingScopedPathError(error) || isMissingFilesystemError(error)) return null
      Logger.error('file:readDocumentPreview rejected out-of-scope path:', error)
      return null
    }
  })

  ipcMain.handle('diagnostics:export', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: `Export ${APP_NAME} Diagnostics`,
          defaultPath: `${APP_SLUG}-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
      : await dialog.showSaveDialog({
          title: `Export ${APP_NAME} Diagnostics`,
          defaultPath: `${APP_SLUG}-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
    if (result.canceled || !result.filePath) return null

    await diagnosticsService.writeReport(result.filePath, {
      appName: app.getName(),
      appVersion: app.getVersion(),
      platform: process.platform,
      platformRelease: release(),
      architecture: process.arch,
      electronVersion: process.versions.electron
    })
    return result.filePath
  })
}
