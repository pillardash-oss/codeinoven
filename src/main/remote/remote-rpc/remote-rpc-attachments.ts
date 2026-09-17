/**
 * Remote attachment staging for the RPC bridge.
 *
 * Chunked uploads from a phone land in a staged temporary file that is only
 * renamed into its final app-owned path once every byte arrived, and reads are
 * restricted to app-owned temporary storage. The dispatch module owns one
 * `RemoteAttachmentStore` instance and routes `attachment:*` channels here.
 */

import { appendFile, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { toPosixPath } from '../../../lib/paths'
import type { ProjectManager } from '../../../lib/engines/project-manager'
import { getConfigRoot } from '../../../lib/utils'
import { PROJECT_DATA_DIRECTORY } from '../../../lib/project-artifacts'
import { threadAttachmentDirectory } from '../../../lib/thread-storage-paths'
import type { RemoteRpcDeviceContext } from '../../../lib/remote-rpc'
import type { AttachmentStorageScope } from '../../../lib/types'
import { requireRemoteDeviceId } from './remote-rpc-args'

const MAX_REMOTE_ATTACHMENT_BYTES = 32 * 1024 * 1024
const MAX_REMOTE_ATTACHMENT_CHUNK_BYTES = 256 * 1024
const REMOTE_ATTACHMENT_READ_CHUNK_BYTES = 192 * 1024
const MAX_CONCURRENT_REMOTE_UPLOADS = 16
const REMOTE_UPLOAD_TTL_MS = 10 * 60 * 1_000

interface RemoteAttachmentUpload {
  deviceId: string
  stagingPath: string
  targetPath: string
  size: number
  received: number
  createdAt: number
}

export class RemoteAttachmentStore {
  private readonly uploads = new Map<string, RemoteAttachmentUpload>()

  constructor(private readonly projectManager: ProjectManager) {}

  async begin(
    device: RemoteRpcDeviceContext | undefined,
    scope: AttachmentStorageScope,
    originalFilename: string,
    rawSize: unknown
  ): Promise<string> {
    const deviceId = requireRemoteDeviceId(device)
    await this.pruneUploads()
    if (this.uploads.size >= MAX_CONCURRENT_REMOTE_UPLOADS) {
      throw new Error('Too many attachment uploads are already in progress')
    }
    if (
      typeof rawSize !== 'number' ||
      !Number.isSafeInteger(rawSize) ||
      rawSize < 1 ||
      rawSize > MAX_REMOTE_ATTACHMENT_BYTES
    ) {
      throw new TypeError('Remote attachment must be between 1 byte and 32 MB')
    }
    if (originalFilename.length < 1 || originalFilename.length > 255) {
      throw new TypeError('Attachment filename is invalid')
    }
    const extension = extname(originalFilename)
    const safeExtension = /^\.[a-z0-9]{1,16}$/iu.test(extension) ? extension.toLowerCase() : ''
    const directory = await this.remoteAttachmentDirectory(scope)
    await mkdir(directory, { recursive: true })
    const uploadId = randomUUID()
    const filename = `dropped-${randomUUID()}${safeExtension}`
    const targetPath = join(directory, filename)
    const stagingPath = join(directory, `.${filename}.${process.pid}.${uploadId}.tmp`)
    await writeFile(stagingPath, new Uint8Array(0), { flag: 'wx', mode: 0o600 })
    this.uploads.set(uploadId, {
      deviceId,
      stagingPath,
      targetPath,
      size: rawSize,
      received: 0,
      createdAt: Date.now()
    })
    return uploadId
  }

  async append(
    device: RemoteRpcDeviceContext | undefined,
    uploadId: string,
    rawOffset: unknown,
    base64Chunk: string
  ): Promise<number> {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.deviceId !== requireRemoteDeviceId(device)) {
      throw new Error('Attachment upload was not found')
    }
    if (rawOffset !== upload.received) throw new Error('Attachment upload chunk is out of order')
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64Chunk)) {
      throw new TypeError('Attachment upload chunk is invalid')
    }
    const bytes = Buffer.from(base64Chunk, 'base64')
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_REMOTE_ATTACHMENT_CHUNK_BYTES) {
      throw new TypeError('Attachment upload chunk is too large')
    }
    if (upload.received + bytes.byteLength > upload.size) {
      throw new TypeError('Attachment upload exceeds the declared file size')
    }
    await appendFile(upload.stagingPath, bytes)
    upload.received += bytes.byteLength
    return upload.received
  }

  async finish(device: RemoteRpcDeviceContext | undefined, uploadId: string): Promise<string> {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.deviceId !== requireRemoteDeviceId(device)) {
      throw new Error('Attachment upload was not found')
    }
    if (upload.received !== upload.size) throw new Error('Attachment upload is incomplete')
    await rename(upload.stagingPath, upload.targetPath)
    this.uploads.delete(uploadId)
    return upload.targetPath
  }

  async cancel(device: RemoteRpcDeviceContext | undefined, uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.deviceId !== requireRemoteDeviceId(device)) return
    this.uploads.delete(uploadId)
    await rm(upload.stagingPath, { force: true }).catch(() => undefined)
  }

  async readChunk(
    requestedPath: string,
    rawOffset: unknown
  ): Promise<{ base64: string; nextOffset: number; size: number }> {
    if (requestedPath.length < 1 || requestedPath.length > 4_096 || !isAbsolute(requestedPath)) {
      throw new TypeError('Attachment path is invalid')
    }
    if (typeof rawOffset !== 'number' || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
      throw new TypeError('Attachment read offset is invalid')
    }

    const canonicalPath = await realpath(resolve(requestedPath))
    const fileInfo = await stat(canonicalPath)
    if (!fileInfo.isFile()) throw new TypeError('Attachment source must be a file')
    if (fileInfo.size < 1 || fileInfo.size > MAX_REMOTE_ATTACHMENT_BYTES) {
      throw new TypeError('Remote attachment must be between 1 byte and 32 MB')
    }
    if (rawOffset > fileInfo.size) throw new RangeError('Attachment read offset exceeds file size')
    if (!(await this.isAppOwnedAttachmentPath(canonicalPath))) {
      throw new Error('Attachment path is outside app-owned temporary storage')
    }

    const byteLength = Math.min(REMOTE_ATTACHMENT_READ_CHUNK_BYTES, fileInfo.size - rawOffset)
    if (byteLength === 0) return { base64: '', nextOffset: rawOffset, size: fileInfo.size }

    const handle = await open(canonicalPath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(byteLength)
      const { bytesRead } = await handle.read(buffer, 0, byteLength, rawOffset)
      if (bytesRead < 1) throw new Error('Attachment read ended unexpectedly')
      return {
        base64: buffer.subarray(0, bytesRead).toString('base64'),
        nextOffset: rawOffset + bytesRead,
        size: fileInfo.size
      }
    } finally {
      await handle.close()
    }
  }

  private async remoteAttachmentDirectory(scope: AttachmentStorageScope): Promise<string> {
    if (
      !scope ||
      (scope.kind !== 'project' && scope.kind !== 'chat') ||
      typeof scope.projectId !== 'string' ||
      typeof scope.threadId !== 'string' ||
      scope.projectId.length === 0 ||
      scope.threadId.length === 0 ||
      scope.projectId.length > 256 ||
      scope.threadId.length > 256 ||
      /[/\\]/u.test(scope.projectId) ||
      /[/\\]/u.test(scope.threadId)
    ) {
      throw new TypeError('Attachment storage scope is invalid')
    }
    const project = await this.projectManager.getProject(scope.projectId)
    return threadAttachmentDirectory(project ?? null, scope)
  }

  private async pruneUploads(): Promise<void> {
    const cutoff = Date.now() - REMOTE_UPLOAD_TTL_MS
    for (const [uploadId, upload] of this.uploads) {
      if (upload.createdAt >= cutoff) continue
      this.uploads.delete(uploadId)
      await rm(upload.stagingPath, { force: true }).catch(() => undefined)
    }
  }

  private async isAppOwnedAttachmentPath(canonicalPath: string): Promise<boolean> {
    const configRoot = await realpath(getConfigRoot()).catch(() => resolve(getConfigRoot()))
    const configRelative = relative(configRoot, canonicalPath)
    if (isContainedRelativePath(configRelative)) {
      const segments = toPosixPath(configRelative).split('/')
      const chatAttachment =
        segments[0] === 'chats' && segments.length >= 4 && segments[2] === 'tmp'
      const projectAttachment =
        segments[0] === 'projects' &&
        segments.length >= 6 &&
        segments[2] === 'threads' &&
        segments[4] === 'tmp'
      if (chatAttachment || projectAttachment) return true
    }

    const projects = await this.projectManager.listProjects()
    for (const project of projects) {
      if (project.source !== 'local' || !project.path) continue
      const root = join(project.path, PROJECT_DATA_DIRECTORY, 'tmp', 'attachments')
      const canonicalRoot = await realpath(root).catch(() => null)
      if (canonicalRoot && isContainedRelativePath(relative(canonicalRoot, canonicalPath))) {
        return true
      }
    }
    return false
  }
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`)
  )
}
