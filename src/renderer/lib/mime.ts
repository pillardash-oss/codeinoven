const EXTENSION_MIME_MAP: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  xml: 'application/xml',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  // Videos
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  // Archives
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  // Code
  js: 'application/javascript',
  ts: 'application/typescript',
  jsx: 'application/javascript',
  tsx: 'application/typescript',
  css: 'text/css',
  html: 'text/html',
  htm: 'text/html',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  // Fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf'
}

export function mimeFromPath(filePath: string, fallback = 'application/octet-stream'): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MIME_MAP[ext] ?? fallback
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

/** SVG is `image/svg+xml` but it must NOT be served through the privileged
 *  `appfile://` scheme (project-controlled active XML). It is rendered natively
 *  in the renderer via a blob URL instead. */
export function isSvgMime(mime: string): boolean {
  return mime === 'image/svg+xml'
}

/** Convert an absolute local file path into a `file://` URL for renderer use. */
export function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${withLeadingSlash}`
}

/** Convert a `file://` URL back into an absolute local file path. */
export function fileUrlToPath(url: string): string {
  // `file:///Users/…` is `file://` + `/Users/…` — the path's leading slash
  // starts at index 7, so slice(7) keeps it. Slicing 8 (`file:///`) would
  // drop the leading slash and turn the absolute path into a broken relative
  // path that readFile() cannot resolve.
  const encodedPath = url.startsWith('file://') ? url.slice('file://'.length) : url
  try {
    return decodeURIComponent(encodedPath)
  } catch {
    return encodedPath
  }
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/')
}

export function isAudioMime(mime: string): boolean {
  return mime.startsWith('audio/')
}

export function isPdfMime(mime: string): boolean {
  return mime === 'application/pdf'
}

export function isMarkdownMime(mime: string): boolean {
  return mime === 'text/markdown' || mime === 'text/x-markdown'
}

export function isPlainTextMime(mime: string): boolean {
  return mime === 'text/plain'
}

const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|m4v|webm|mov|avi|mkv|mpeg|mpg|ogv)$/iu
const AUDIO_EXTENSION_PATTERN = /\.(?:mp3|wav|ogg|oga|m4a|flac|aac|opus)$/iu

/** Filename extensions treated as readable text/raw attachments. Mirrors the
 *  extensions the harness drivers inline as text so the preview and the model
 *  stay consistent. */
const TEXT_EXTENSION_PATTERN =
  /\.(?:txt|text|log|md|mdown|markdown|json|jsonc|jsonl|js|mjs|cjs|jsx|ts|tsx|css|scss|html|htm|py|rb|go|rs|java|sh|bash|zsh|yaml|yml|toml|xml|sql|ini|cfg|conf|properties|env|svelte|vue)$/iu
const CSV_EXTENSION_PATTERN = /\.(?:csv|tsv)$/iu

/** The kind of inline preview a chat attachment supports, or `null` when the
 *  file type has no renderer (images render as `<img>`, PDF and converted DOCX
 *  content in isolated frames, video/audio via the native media elements,
 *  markdown via `MarkdownView`, plain text raw, CSV as a table). Filename
 *  extensions provide a fallback for files whose reported mime is
 *  `application/octet-stream` or empty. */
export type AttachmentPreviewKind =
  'image' | 'pdf' | 'document' | 'video' | 'audio' | 'markdown' | 'text' | 'csv'

export function attachmentPreviewKind(
  mime: string,
  filename: string
): AttachmentPreviewKind | null {
  if (isImageMime(mime)) return 'image'
  if (isVideoMime(mime) || VIDEO_EXTENSION_PATTERN.test(filename)) return 'video'
  if (isAudioMime(mime) || AUDIO_EXTENSION_PATTERN.test(filename)) return 'audio'
  if (isPdfMime(mime) || /\.pdf$/iu.test(filename)) return 'pdf'
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/iu.test(filename)
  ) {
    return 'document'
  }
  if (
    mime === 'text/csv' ||
    mime === 'text/tab-separated-values' ||
    CSV_EXTENSION_PATTERN.test(filename)
  ) {
    return 'csv'
  }
  if (isMarkdownMime(mime) || /\.(?:md|mdown|markdown)$/iu.test(filename)) return 'markdown'
  if (isPlainTextMime(mime) || TEXT_EXTENSION_PATTERN.test(filename)) return 'text'
  return null
}

export function isDocMime(mime: string): boolean {
  return (
    mime.startsWith('application/vnd.openxmlformats-officedocument') ||
    mime === 'application/msword'
  )
}
