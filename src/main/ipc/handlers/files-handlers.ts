import { extname, join } from 'path'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { retainTemporaryAttachment } from '../../editor/temporary-attachment-retention'
import { retainRemoteMediaAttachment } from '../../editor/remote-media-attachment'
import { validateBoundedString } from '../ipc-validation'
import { validateAttachmentStorageScope } from './shared'
import type { IpcHandlerContext } from './context'

/** Upper bound on one pathless (browser-drag) attachment payload. */
const MAX_PATHLESS_ATTACHMENT_BYTES = 32 * 1024 * 1024

export function registerFilesHandlers(ctx: IpcHandlerContext): void {
  const { privilegedIpc, privileged, attachmentStorageDirectory } = ctx

  privileged('file:registerSelection', async (_event, selection: unknown, rawScope: unknown) => {
    const scope = rawScope === undefined ? null : validateAttachmentStorageScope(rawScope)
    let retainedPath: string

    if (typeof selection === 'string') {
      if (selection.length === 0) return null
      retainedPath = scope
        ? await retainTemporaryAttachment(selection, await attachmentStorageDirectory(scope))
        : selection
    } else {
      if (!scope || typeof selection !== 'object' || selection === null) return null
      const record = selection as Record<string, unknown>
      const originalFilename = validateBoundedString(
        record['filename'],
        'Dropped attachment filename',
        1,
        255
      )
      const bytes = record['bytes']
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('Dropped attachment bytes must be binary data')
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PATHLESS_ATTACHMENT_BYTES) {
        throw new TypeError('Dropped browser attachment must be between 1 byte and 32 MB')
      }

      const originalExtension = extname(originalFilename)
      const safeExtension = /^\.[a-z0-9]{1,16}$/iu.test(originalExtension)
        ? originalExtension.toLowerCase()
        : ''
      const filename = `dropped-${randomUUID()}${safeExtension}`
      const directory = await attachmentStorageDirectory(scope)
      await mkdir(directory, { recursive: true })
      retainedPath = join(directory, filename)
      const stagingPath = join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
      try {
        await writeFile(stagingPath, bytes, { flag: 'wx', mode: 0o600 })
        await rename(stagingPath, retainedPath)
      } catch (error) {
        await rm(stagingPath, { force: true }).catch(() => undefined)
        throw error
      }
    }

    await privilegedIpc.registerUserSelectedFile(retainedPath)
    return retainedPath
  })

  /**
   * Retain a media link a drag carried.
   *
   * A drag out of a web page carries no file, only the link, so the bytes are
   * fetched here (the renderer cannot: a cross-origin read answers with an opaque
   * body). The link is untrusted even though the gesture is deliberate, so the
   * transfer applies its own source rules and refuses anything that does not turn
   * out to be image, video or audio.
   */
  privileged('attachment:retainRemote', async (_event, rawScope: unknown, source: unknown) => {
    const scope = validateAttachmentStorageScope(rawScope)
    if (typeof source !== 'string' || source.length === 0) {
      throw new TypeError('Attachment link must be a non-empty string')
    }
    const directory = await attachmentStorageDirectory(scope)
    const saved = await retainRemoteMediaAttachment({ source, directory })
    await privilegedIpc.registerUserSelectedFile(saved.path)
    return saved.path
  })
}
