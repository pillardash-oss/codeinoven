/// <reference types="node" />

import { protocol } from 'electron'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join, sep } from 'path'
import { realpath } from 'fs/promises'
import { getConfigRoot } from '../../lib/utils'
import { previewTypeForPath, type PreviewType } from '../../lib/preview-types'
import { byteRange, previewHeaders } from '../../lib/preview-range'
import { Logger } from '../system/logger'
import { MediaServer } from './media-server/media-server'
import type { ProjectFilesService } from './project-files-service'

const SCHEME = 'appfile'
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u
const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{24}$/u
/** Thread IDs follow the same safe-entity charset as project IDs. */
const THREAD_ID_PATTERN = /^[a-zA-Z0-9._-]+$/u

// Which extensions may be served, and how large each may be, is one shared
// declaration (`src/lib/preview-types.ts`): the inline artifact pipeline reads
// the same table, so a type the app can publish is always a type it can stream.

/**
 * Register the `appfile://` scheme as privileged. Must run before the app is
 * ready. `standard` + `stream` make the scheme usable by Chromium's built-in
 * PDF viewer inside an iframe; `bypassCSP` is required because the PDF plugin
 * historically fails to load custom protocols that are subject to the page CSP
 * (electron/electron#24859).
 */
export function registerFilePreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    }
  ])
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

/**
 * A media file is handed to the loopback server instead of being streamed from
 * here, and anything else keeps the streamed response it always had.
 *
 * The redirect is what takes the bytes off this process's thread: the renderer
 * follows `Location` and from then on Chromium reads the file through the
 * worker, so no chunk of a playing video crosses the main thread. A media server
 * that cannot start returns null, and the file is streamed exactly as before.
 */
async function serveLocalFile(
  mediaServer: MediaServer,
  absolutePath: string,
  type: PreviewType,
  request: Request
): Promise<Response> {
  if (type.kind === 'audio' || type.kind === 'video') {
    const location = await mediaServer.urlFor({
      path: absolutePath,
      extension: type.extension,
      mime: type.mime
    })
    if (location) {
      return new Response(null, {
        status: 302,
        headers: { 'Cache-Control': 'no-store', Location: location }
      })
    }
  }
  return serveFile(absolutePath, type, request)
}

async function serveFile(
  absolutePath: string,
  type: PreviewType,
  request: Request
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' }
    })
  }

  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > type.maxBytes) {
      await handle.close()
      return notFound()
    }
    const rangeValue = request.headers.get('range')
    const range = byteRange(rangeValue, metadata.size)
    if (!range) {
      await handle.close()
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}` }
      })
    }
    const contentLength = range.end - range.start + 1
    const headers = previewHeaders(type, contentLength)
    const isPartial = rangeValue !== null
    if (isPartial)
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`)
    if (request.method === 'HEAD') {
      await handle.close()
      return new Response(null, { status: 200, headers })
    }

    const stream = handle.createReadStream({
      start: range.start,
      end: range.end,
      autoClose: true
    })
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: isPartial ? 206 : 200,
      headers
    })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function serveRemoteFile(
  file: { size: number; read(offset: number): Promise<Uint8Array> },
  type: PreviewType,
  request: Request
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405 })
  if (file.size < 1 || file.size > type.maxBytes) return notFound()
  const rangeValue = request.headers.get('range')
  const range = byteRange(rangeValue, file.size)
  if (!range)
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } })
  const headers = previewHeaders(type, range.end - range.start + 1)
  if (rangeValue !== null)
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  let offset = range.start
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > range.end) {
        controller.close()
        return
      }
      try {
        const bytes = await file.read(offset)
        if (bytes.length === 0) throw new Error('The remote preview changed while being read.')
        const chunk = bytes.subarray(0, range.end - offset + 1)
        offset += chunk.length
        controller.enqueue(chunk)
      } catch (error) {
        controller.error(error)
      }
    }
  })
  return new Response(body, { status: rangeValue !== null ? 206 : 200, headers })
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
}

/**
 * Serve files directly from disk via the `appfile://` scheme so the renderer
 * can preview images and PDFs with a real `src` URL instead of a base64 IPC
 * dump. Two URL shapes are supported:
 *
 * - `appfile://project/<projectId>/<relativePath>`   resolved against the
 *   project root through {@link ProjectFilesService#resolveForExternalEditor}
 * - `appfile://thread/<projectId>/<threadId>/<relativePath>`   resolved against
 *   the conversation's own app-owned workspace directory (a chat's
 *   `chats-cwd/<threadId>`, an assistant task's
 *   `assistant-cwd/<assistantId ?? threadId>`)
 * - `appfile://attachment/<projectId>/<attachmentId>?name=<label>`   an
 *   out-of-project attachment copied into CodeInOven storage
 * - `appfile://standalone/file?path=<absolute>&name=<label>`   a single file
 *   the user opened through the operating system, authorized by the scoped
 *   path resolver (the same grants privileged IPC uses)
 *
 * The handler is installed via a lazy {@link ProjectFilesService} resolver so
 * it can be registered before the main window loads (the packaged renderer
 * requests `appfile://` previews as soon as it hydrates; installing the handler
 * any later makes those requests fail with `ERR_UNKNOWN_URL_SCHEME`).
 */
export function installFilePreviewProtocol(
  getProjectFiles: () => ProjectFilesService | null,
  resolveScopedPath?: (value: unknown) => Promise<string>
): void {
  /** Long-lived, so a scrub through a video reuses one grant; idle-stopped. */
  const mediaServer = new MediaServer()
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)

      if (url.host === 'project') {
        const segments = decodeSegments(url.pathname)
        const projectId = segments[0] ?? ''
        if (!PROJECT_ID_PATTERN.test(projectId)) return notFound()
        const relativePath = segments.slice(1).join('/')
        if (!relativePath) return notFound()
        const type = previewTypeForPath(relativePath, url.searchParams.get('mime') ?? undefined)
        if (!type) return notFound()
        const projectFiles = getProjectFiles()
        if (!projectFiles) return notFound()
        const absolutePath = await projectFiles.resolveForExternalEditor(projectId, relativePath)
        return serveLocalFile(mediaServer, absolutePath, type, request)
      }

      if (url.host === 'thread') {
        const segments = decodeSegments(url.pathname)
        const projectId = segments[0] ?? ''
        if (!PROJECT_ID_PATTERN.test(projectId)) return notFound()
        const threadId = segments[1] ?? ''
        if (!THREAD_ID_PATTERN.test(threadId)) return notFound()
        const relativePath = segments.slice(2).join('/')
        if (!relativePath) return notFound()
        const type = previewTypeForPath(relativePath, url.searchParams.get('mime') ?? undefined)
        if (!type) return notFound()
        const projectFiles = getProjectFiles()
        if (!projectFiles) return notFound()
        const remote = await projectFiles.remoteFileReader?.(projectId, threadId, relativePath)
        if (remote) return serveRemoteFile(remote, type, request)
        const absolutePath = await projectFiles.resolveForExternalEditor(
          projectId,
          relativePath,
          undefined,
          threadId
        )
        return serveLocalFile(mediaServer, absolutePath, type, request)
      }

      if (url.host === 'standalone') {
        const absolutePath = url.searchParams.get('path') ?? ''
        const name = url.searchParams.get('name') ?? absolutePath
        if (!absolutePath) return notFound()
        const type = previewTypeForPath(name, url.searchParams.get('mime') ?? undefined)
        if (!type) return notFound()
        // Authorization is shared with privileged IPC: only paths the user
        // opened (or picked in a dialog) resolve to a canonical path here.
        if (!resolveScopedPath) return notFound()
        const safePath = await resolveScopedPath(absolutePath)
        return serveLocalFile(mediaServer, safePath, type, request)
      }

      if (url.host === 'attachment') {
        const segments = decodeSegments(url.pathname)
        const projectId = segments[0] ?? ''
        const attachmentId = segments[1] ?? ''
        if (!PROJECT_ID_PATTERN.test(projectId)) return notFound()
        if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return notFound()

        const attachmentsDir = join(
          getConfigRoot(),
          'projects',
          projectId,
          'spec-context',
          'attachments'
        )
        const absolutePath = join(attachmentsDir, attachmentId)
        try {
          const [resolvedDir, resolvedPath] = await Promise.all([
            realpath(attachmentsDir),
            realpath(absolutePath)
          ])
          if (!resolvedPath.startsWith(resolvedDir + sep)) return notFound()
        } catch {
          return notFound()
        }

        const name = url.searchParams.get('name') ?? ''
        const type = previewTypeForPath(name, url.searchParams.get('mime') ?? undefined)
        if (!type) return notFound()
        return serveLocalFile(mediaServer, absolutePath, type, request)
      }

      return notFound()
    } catch (error) {
      Logger.error('appfile protocol request failed:', error)
      return notFound()
    }
  })
}
