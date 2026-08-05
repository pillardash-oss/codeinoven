import { protocol, net } from 'electron'
import { extname, join, sep } from 'path'
import { pathToFileURL } from 'url'
import { realpath } from 'fs/promises'
import { getConfigRoot } from '../lib/utils'
import { Logger } from './logger'
import type { ProjectFilesService } from './project-files-service'

const SCHEME = 'appfile'
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u
const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{24}$/u

const PREVIEW_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus'
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

function mimeFromPath(path: string): string {
  return PREVIEW_MIME_MAP[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

async function serveFile(absolutePath: string, mime: string, request: Request): Promise<Response> {
  const range = request.headers.get('range')
  const fileUrl = pathToFileURL(absolutePath).toString()
  const init: RequestInit = range ? { headers: { Range: range } } : {}
  const response = await net.fetch(fileUrl, init)
  if (!response.ok) return notFound()
  const headers = new Headers(response.headers)
  headers.set('content-type', mime)
  return new Response(response.body, { status: response.status, headers })
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
        const absolutePath = await projectFiles.resolveForExternalEditor(projectId, relativePath)
        return serveFile(absolutePath, mimeFromPath(relativePath), request)
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
        return serveFile(absolutePath, mimeFromPath(name), request)
      }

      return notFound()
    } catch (error) {
      Logger.error('appfile protocol request failed:', error)
      return notFound()
    }
  })
}
