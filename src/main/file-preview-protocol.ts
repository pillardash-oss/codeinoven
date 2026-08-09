/// <reference types="node" />

import { protocol } from 'electron'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { extname, join, sep } from 'path'
import { realpath } from 'fs/promises'
import { getConfigRoot } from '../lib/utils'
import { Logger } from './logger'
import type { ProjectFilesService } from './project-files-service'

const SCHEME = 'appfile'
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u
const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{24}$/u

interface PreviewType {
  extension: string
  maxBytes: number
  mime: string
}

const MIB = 1024 * 1024
const IMAGE_MAX_BYTES = 32 * MIB
const DOCUMENT_MAX_BYTES = 64 * MIB
const MEDIA_MAX_BYTES = 512 * MIB

function previewType(extension: string, mime: string, maxBytes: number): PreviewType {
  return { extension, mime, maxBytes }
}

const PREVIEW_TYPES: Record<string, PreviewType> = {
  '.png': previewType('.png', 'image/png', IMAGE_MAX_BYTES),
  '.jpg': previewType('.jpg', 'image/jpeg', IMAGE_MAX_BYTES),
  '.jpeg': previewType('.jpeg', 'image/jpeg', IMAGE_MAX_BYTES),
  '.gif': previewType('.gif', 'image/gif', IMAGE_MAX_BYTES),
  '.webp': previewType('.webp', 'image/webp', IMAGE_MAX_BYTES),
  // SVG is intentionally excluded: project-controlled active XML must not run
  // in a privileged custom-scheme document. It remains available as text.
  '.ico': previewType('.ico', 'image/x-icon', IMAGE_MAX_BYTES),
  '.bmp': previewType('.bmp', 'image/bmp', IMAGE_MAX_BYTES),
  '.pdf': previewType('.pdf', 'application/pdf', DOCUMENT_MAX_BYTES),
  '.mp4': previewType('.mp4', 'video/mp4', MEDIA_MAX_BYTES),
  '.m4v': previewType('.m4v', 'video/x-m4v', MEDIA_MAX_BYTES),
  '.webm': previewType('.webm', 'video/webm', MEDIA_MAX_BYTES),
  '.mov': previewType('.mov', 'video/quicktime', MEDIA_MAX_BYTES),
  '.mpeg': previewType('.mpeg', 'video/mpeg', MEDIA_MAX_BYTES),
  '.mpg': previewType('.mpg', 'video/mpeg', MEDIA_MAX_BYTES),
  '.ogv': previewType('.ogv', 'video/ogg', MEDIA_MAX_BYTES),
  '.ogg': previewType('.ogg', 'audio/ogg', MEDIA_MAX_BYTES),
  '.oga': previewType('.oga', 'audio/ogg', MEDIA_MAX_BYTES),
  '.mp3': previewType('.mp3', 'audio/mpeg', MEDIA_MAX_BYTES),
  '.wav': previewType('.wav', 'audio/wav', MEDIA_MAX_BYTES),
  '.m4a': previewType('.m4a', 'audio/mp4', MEDIA_MAX_BYTES),
  '.flac': previewType('.flac', 'audio/flac', MEDIA_MAX_BYTES),
  '.aac': previewType('.aac', 'audio/aac', MEDIA_MAX_BYTES),
  '.opus': previewType('.opus', 'audio/opus', MEDIA_MAX_BYTES)
}

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

function typeFromPath(path: string): PreviewType | null {
  return PREVIEW_TYPES[extname(path).toLowerCase()] ?? null
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

function previewHeaders(type: PreviewType, contentLength: number): Headers {
  return new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="preview${type.extension}"`,
    'Content-Length': String(contentLength),
    'Content-Security-Policy':
      "default-src 'none'; script-src 'none'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    'Content-Type': type.mime,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
}

function byteRange(value: string | null, size: number): { end: number; start: number } | null {
  if (!value) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null
  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return null
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(rawStart)
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
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
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: isPartial ? 206 : 200,
      headers
    })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
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
 * - `appfile://project/<projectId>/<relativePath>` — resolved against the
 *   project root through {@link ProjectFilesService#resolveForExternalEditor}
 * - `appfile://attachment/<projectId>/<attachmentId>?name=<label>` — an
 *   out-of-project attachment copied into CodeInOven storage
 */
export function installFilePreviewProtocol(projectFiles: ProjectFilesService): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)

      if (url.host === 'project') {
        const segments = decodeSegments(url.pathname)
        const projectId = segments[0] ?? ''
        if (!PROJECT_ID_PATTERN.test(projectId)) return notFound()
        const relativePath = segments.slice(1).join('/')
        if (!relativePath) return notFound()
        const type = typeFromPath(relativePath)
        if (!type) return notFound()
        const absolutePath = await projectFiles.resolveForExternalEditor(projectId, relativePath)
        return serveFile(absolutePath, type, request)
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
        const type = typeFromPath(name)
        if (!type) return notFound()
        return serveFile(absolutePath, type, request)
      }

      return notFound()
    } catch (error) {
      Logger.error('appfile protocol request failed:', error)
      return notFound()
    }
  })
}
