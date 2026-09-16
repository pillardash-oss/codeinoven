/**
 * Extension → media-type table for CodeInOven's main-process static servers.
 *
 * Pure string logic with no `node:path` import, so the renderer, shared
 * engines, and build scripts can consume it too.
 *
 * This is the single table for servers that stream a *user's own project
 * files* to a browser document (the directory preview server and the prototype
 * preview origin). It is deliberately broad: a directory preview must serve
 * whatever an agent-generated prototype references, or asset loading silently
 * breaks. Callers that need a narrower security envelope (the size-bounded,
 * media-only `appfile://` scheme) keep their own allow-list.
 */

/** Fallback for unknown or extension-less paths. */
export const DEFAULT_MIME_TYPE = 'application/octet-stream'

const MIME_TYPES: Readonly<Record<string, string>> = {
  // Documents
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',

  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // Audio and video
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.ogv': 'video/ogg'
}

/**
 * Media type for a POSIX or Windows path's extension, falling back to
 * `application/octet-stream`. A dot in a directory segment never counts as an
 * extension, so `dist.v2/README` stays text-less instead of resolving `.v2`.
 */
export function mimeTypeForPath(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  if (dot <= slash || dot === path.length - 1) return DEFAULT_MIME_TYPE
  return MIME_TYPES[path.slice(dot).toLowerCase()] ?? DEFAULT_MIME_TYPE
}
