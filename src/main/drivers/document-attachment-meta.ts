import type { PromptAttachment } from '../../lib/types'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const ODT_MIME = 'application/vnd.oasis.opendocument.text'
const DOC_MIME = 'application/msword'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS_MIME = 'application/vnd.ms-excel'
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet'
const CSV_MIME = 'text/csv'
/** The document formats this module can extract content from. */
type DocumentKind = 'docx' | 'doc' | 'odt' | 'pptx' | 'xlsx' | 'xls' | 'ods' | 'csv'

export function documentAttachmentLabel(attachment: PromptAttachment): string {
  return (attachment.filename ?? attachment.url).replace(/[\r\n]+/gu, ' ')
}

function documentExtension(attachment: PromptAttachment): string {
  const source = attachment.filename ?? attachment.url
  const withoutQuery = source.split(/[?#]/u, 1)[0] ?? ''
  const dot = withoutQuery.lastIndexOf('.')
  return dot < 0 ? '' : withoutQuery.slice(dot + 1).toLowerCase()
}

export function extensionIsTsv(attachment: PromptAttachment): boolean {
  return documentExtension(attachment) === 'tsv'
}

/** Resolve the document kind from the mime type first, falling back to the
 *  filename extension (many sources report `application/octet-stream`). */
export function documentKind(attachment: PromptAttachment): DocumentKind | null {
  const mime = attachment.mime.toLowerCase().split(';', 1)[0] ?? ''
  if (mime === DOCX_MIME) return 'docx'
  if (mime === DOC_MIME) return 'doc'
  if (mime === ODT_MIME) return 'odt'
  if (mime === PPTX_MIME) return 'pptx'
  if (mime === XLSX_MIME) return 'xlsx'
  if (mime === XLS_MIME) return 'xls'
  if (mime === ODS_MIME) return 'ods'
  if (mime === CSV_MIME) return 'csv'
  const extension = documentExtension(attachment)
  if (
    extension === 'docx' ||
    extension === 'doc' ||
    extension === 'odt' ||
    extension === 'pptx' ||
    extension === 'xlsx' ||
    extension === 'xls' ||
    extension === 'ods' ||
    extension === 'csv' ||
    extension === 'tsv'
  ) {
    return extension === 'tsv' ? 'csv' : extension
  }
  return null
}

/** True when an attachment is a document with extractable content (DOCX,
 *  legacy DOC, ODT, PPTX). */
export function isDocumentAttachment(attachment: PromptAttachment): boolean {
  return documentKind(attachment) !== null
}

/** Wrap extracted document content in a clear model-facing boundary. */
export function formatDocumentAsText(attachment: PromptAttachment, content: string): string {
  const label = documentAttachmentLabel(attachment)
  return [
    `Attached document ${label} (extracted text):`,
    `--- BEGIN DOCUMENT ${label} ---`,
    content,
    `--- END DOCUMENT ${label} ---`
  ].join('\n\n')
}
