import {
  isAudioMime,
  isDocumentPreviewPath,
  isHtmlPreviewPath,
  isImageMime,
  isSvgMime,
  isVideoMime,
  mimeFromPath
} from '$lib/mime'

export interface FilePreviewFlags {
  markdown: boolean
  html: boolean
  pdf: boolean
  image: boolean
  svg: boolean
  video: boolean
  audio: boolean
  document: boolean
}

const NO_PREVIEW: FilePreviewFlags = {
  markdown: false,
  html: false,
  pdf: false,
  image: false,
  svg: false,
  video: false,
  audio: false,
  document: false
}

export function filePreviewFlags(path: string | null): FilePreviewFlags {
  if (!path) return NO_PREVIEW
  const mime = mimeFromPath(path)
  return {
    markdown: /\.(?:md|mdown|markdown)$/iu.test(path),
    html: isHtmlPreviewPath(path),
    pdf: /\.pdf$/iu.test(path),
    image: isImageMime(mime),
    svg: isSvgMime(mime),
    video: isVideoMime(mime),
    audio: isAudioMime(mime),
    document: isDocumentPreviewPath(path)
  }
}

/** Name of the preview renderer for the active file; keeps the Eye toggle's
 *  labels identical in the inline and fullscreen toolbars. */
export function previewKindLabel(flags: FilePreviewFlags): string {
  if (flags.pdf) return 'PDF'
  if (flags.video) return 'Video'
  if (flags.audio) return 'Audio'
  if (flags.document) return 'Document'
  if (flags.html) return 'HTML'
  if (flags.image) return 'Image'
  return 'Markdown'
}

export function hasAnyPreview(flags: FilePreviewFlags): boolean {
  return (
    flags.markdown ||
    flags.html ||
    flags.pdf ||
    flags.image ||
    flags.video ||
    flags.audio ||
    flags.document
  )
}
