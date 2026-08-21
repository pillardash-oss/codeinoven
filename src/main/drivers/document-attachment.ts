/// <reference types="node" />

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Logger } from '../system/logger'
import type { PromptAttachment } from '../../lib/types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MAX_DOCX_BYTES = 16 * 1024 * 1024
const MAX_EXTRACTED_CHARACTERS = 200_000
const MAX_PREVIEW_CHARACTERS = 4_000_000

function documentAttachmentLabel(attachment: PromptAttachment): string {
  return (attachment.filename ?? attachment.url).replace(/[\r\n]+/gu, ' ')
}

/** True when an attachment is a modern Microsoft Word document. */
export function isWordDocumentAttachment(attachment: PromptAttachment): boolean {
  const mime = attachment.mime.toLowerCase().split(';', 1)[0] ?? ''
  if (mime === DOCX_MIME) return true
  const source = (attachment.filename ?? attachment.url).toLowerCase()
  return /\.docx(?:$|[?#])/u.test(source)
}

async function documentAttachmentBytes(attachment: PromptAttachment): Promise<Buffer | null> {
  if (attachment.url.startsWith('data:')) {
    const separator = attachment.url.indexOf(',')
    if (separator < 0) return null
    const metadata = attachment.url.slice(0, separator)
    const payload = attachment.url.slice(separator + 1)
    if (!payload) return null
    const bytes = metadata.endsWith(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
    return bytes.byteLength <= MAX_DOCX_BYTES ? bytes : null
  }
  if (/^https?:\/\//u.test(attachment.url)) return null

  const path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  const details = await stat(path)
  if (!details.isFile() || details.size > MAX_DOCX_BYTES) return null
  return readFile(path)
}

function boundDocumentText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_EXTRACTED_CHARACTERS) return trimmed
  const omitted = trimmed.length - MAX_EXTRACTED_CHARACTERS
  return `${trimmed.slice(0, MAX_EXTRACTED_CHARACTERS)}\n\n[Document truncated: ${omitted.toLocaleString('en-US')} additional characters omitted.]`
}

/**
 * Extract model-readable text from a local or embedded DOCX. Returns null when
 * the source is unavailable, oversized, invalid, or contains no readable text.
 */
export async function readWordDocumentText(attachment: PromptAttachment): Promise<string | null> {
  if (!isWordDocumentAttachment(attachment)) return null
  try {
    const bytes = await documentAttachmentBytes(attachment)
    if (!bytes) return null
    const mammoth = (await import('mammoth')).default
    const result = await mammoth.extractRawText({ buffer: bytes })
    const text = boundDocumentText(result.value)
    return text || null
  } catch (error) {
    Logger.error(`Failed to extract Word document ${documentAttachmentLabel(attachment)}:`, error)
    return null
  }
}

/**
 * Convert a local or embedded DOCX to semantic HTML for the attachment preview.
 * The renderer sanitizes and isolates this markup before displaying it.
 */
export async function readWordDocumentHtml(attachment: PromptAttachment): Promise<string | null> {
  if (!isWordDocumentAttachment(attachment)) return null
  try {
    const bytes = await documentAttachmentBytes(attachment)
    if (!bytes) return null
    const mammoth = (await import('mammoth')).default
    const result = await mammoth.convertToHtml({ buffer: bytes })
    const html = result.value.trim()
    if (!html || html.length > MAX_PREVIEW_CHARACTERS) return null
    return html
  } catch (error) {
    Logger.error(`Failed to render Word document ${documentAttachmentLabel(attachment)}:`, error)
    return null
  }
}

/** Wrap extracted DOCX content in a clear model-facing boundary. */
export function formatWordDocumentAsText(attachment: PromptAttachment, content: string): string {
  const label = documentAttachmentLabel(attachment)
  return [
    `Attached Word document ${label} (extracted text):`,
    `--- BEGIN DOCUMENT ${label} ---`,
    content,
    `--- END DOCUMENT ${label} ---`
  ].join('\n\n')
}
