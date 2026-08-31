/// <reference types="node" />

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Logger } from '../system/logger'
import type { PromptAttachment } from '../../lib/types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const ODT_MIME = 'application/vnd.oasis.opendocument.text'
const DOC_MIME = 'application/msword'
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

function documentExtension(attachment: PromptAttachment): string {
  const source = attachment.filename ?? attachment.url
  const withoutQuery = source.split(/[?#]/u, 1)[0] ?? ''
  const dot = withoutQuery.lastIndexOf('.')
  return dot < 0 ? '' : withoutQuery.slice(dot + 1).toLowerCase()
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function paragraphsToHtml(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('\n')
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

async function readModernWordDocumentHtml(bytes: Buffer): Promise<string | null> {
  const mammoth = (await import('mammoth')).default
  const result = await mammoth.convertToHtml({ buffer: bytes })
  const html = result.value.trim()
  return html || null
}

/** Legacy binary `.doc`: extract plain text via word-extractor, one `<p>` per
 *  paragraph. Formatting is not recoverable from the OLE container. */
async function readLegacyWordDocumentHtml(bytes: Buffer): Promise<string | null> {
  const WordExtractor = (await import('word-extractor')).default
  const extracted = await new WordExtractor().extract(bytes)
  const paragraphs = extracted.getBody().split(/\r\n|\r|\n/u)
  const html = paragraphsToHtml(paragraphs)
  return html || null
}

/** ODT: parse `content.xml` and map headings, paragraphs, and lists to
 *  semantic HTML. Inline character formatting is flattened to plain text. */
async function readOpenDocumentTextHtml(bytes: Buffer): Promise<string | null> {
  const { default: JSZip } = await import('jszip')
  const { DOMParser } = await import('@xmldom/xmldom')
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file('content.xml')
  if (!entry) return null
  const xml = await entry.async('string')
  const parsed = new DOMParser().parseFromString(xml, 'text/xml')

  const blocks: string[] = []

  function collectBlocks(container: Node, out: string[]): void {
    for (let i = 0; i < container.childNodes.length; i += 1) {
      const node = container.childNodes.item(i)
      if (node.nodeType !== node.ELEMENT_NODE) continue
      const element = node as Element
      if (element.localName === 'h') {
        const level = Math.min(
          Math.max(
            Number(
              element.getAttributeNS(
                'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
                'outline-level'
              )
            ) || 1,
            1
          ),
          6
        )
        const text = (element.textContent ?? '').trim()
        if (text) out.push(`<h${level}>${escapeHtml(text)}</h${level}>`)
      } else if (element.localName === 'p') {
        const text = (element.textContent ?? '').trim()
        if (text) out.push(`<p>${escapeHtml(text)}</p>`)
      } else if (element.localName === 'list') {
        collectListItemsInto(element, out)
      } else {
        collectBlocks(element, out)
      }
    }
  }

  function collectListItemsInto(list: Element, out: string[]): void {
    const items: string[] = []
    for (let i = 0; i < list.childNodes.length; i += 1) {
      const child = list.childNodes.item(i)
      if (child.nodeType !== child.ELEMENT_NODE) continue
      const element = child as Element
      if (element.localName === 'list-item') {
        const itemBlocks: string[] = []
        collectBlocks(element, itemBlocks)
        const itemHtml = itemBlocks.join('')
        if (itemHtml) items.push(`<li>${itemHtml}</li>`)
      }
    }
    if (items.length > 0) {
      out.push(`<ul>\n${items.join('\n')}\n</ul>`)
    }
  }

  const body = parsed.getElementsByTagNameNS(
    'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    'text'
  ).item(0)
  if (!body) return null
  collectBlocks(body, blocks)
  const html = blocks.join('\n')
  return html || null
}

interface PptxParagraph {
  text: string
}

interface PptxShape {
  title: boolean
  paragraphs: PptxParagraph[]
}

function parsePptxTextParagraph(paragraph: Element): PptxParagraph {
  const runNodes = paragraph.getElementsByTagName('a:t')
  const runs: string[] = []
  for (let i = 0; i < runNodes.length; i += 1) {
    runs.push(runNodes.item(i)?.textContent ?? '')
  }
  return { text: runs.join('').trim() }
}

function parsePptxShape(shape: Element): PptxShape | null {
  const placeholder = shape.getElementsByTagName('p:ph').item(0)
  const placeholderType = placeholder?.getAttribute('type') ?? ''
  const title = placeholderType === 'title' || placeholderType === 'ctrTitle'
  const paragraphs: PptxParagraph[] = []
  const paragraphNodes = shape.getElementsByTagName('a:p')
  for (let i = 0; i < paragraphNodes.length; i += 1) {
    const paragraph = parsePptxTextParagraph(paragraphNodes.item(i) as Element)
    if (paragraph.text) paragraphs.push(paragraph)
  }
  if (paragraphs.length === 0) return null
  return { title, paragraphs }
}

/** PPTX: read slides in deck order and render each as a `<section>` with its
 *  title placeholder as `<h2>`. Slide text only — images and charts are
 *  omitted. */
async function readPptxDocumentHtml(bytes: Buffer): Promise<string | null> {
  const { default: JSZip } = await import('jszip')
  const { DOMParser } = await import('@xmldom/xmldom')
  const zip = await JSZip.loadAsync(bytes)
  const slideNumbers: number[] = []
  zip.forEach((path) => {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/u.exec(path)
    if (match?.[1]) slideNumbers.push(Number(match[1]))
  })
  slideNumbers.sort((a, b) => a - b)
  if (slideNumbers.length === 0) return null

  const sections: string[] = []
  for (let index = 0; index < slideNumbers.length; index += 1) {
    const entry = zip.file(`ppt/slides/slide${slideNumbers[index]}.xml`)
    if (!entry) continue
    const xml = await entry.async('string')
    const parsed = new DOMParser().parseFromString(xml, 'text/xml')
    const shapes: PptxShape[] = []
    const shapeNodes = parsed.getElementsByTagName('p:sp')
    for (let i = 0; i < shapeNodes.length; i += 1) {
      const shape = parsePptxShape(shapeNodes.item(i) as Element)
      if (shape) shapes.push(shape)
    }
    const titleShape = shapes.find((shape) => shape.title) ?? null
    const bodyShapes = shapes.filter((shape) => shape !== titleShape)
    const body: string[] = []
    if (titleShape) {
      body.push(`<h2>${escapeHtml(titleShape.paragraphs.map((p) => p.text).join(' '))}</h2>`)
    } else {
      body.push(`<h2>Slide ${index + 1}</h2>`)
    }
    for (const shape of bodyShapes) {
      const html = paragraphsToHtml(shape.paragraphs.map((paragraph) => paragraph.text))
      if (html) body.push(html)
    }
    if (body.length > 1) {
      sections.push(`<section>\n${body.join('\n')}\n</section>`)
    }
  }
  const html = sections.join('\n<hr>\n')
  return html || null
}

/**
 * Convert a supported document attachment (DOCX, legacy DOC, ODT, PPTX) to
 * semantic HTML for the attachment preview. The renderer sanitizes and isolates
 * this markup before displaying it.
 */
export async function readDocumentPreviewHtml(attachment: PromptAttachment): Promise<string | null> {
  try {
    const bytes = await documentAttachmentBytes(attachment)
    if (!bytes) return null
    const extension = documentExtension(attachment)
    const mime = attachment.mime.toLowerCase().split(';', 1)[0] ?? ''
    let html: string | null = null
    if (extension === 'docx' || mime === DOCX_MIME) {
      html = await readModernWordDocumentHtml(bytes)
    } else if (extension === 'doc' || mime === DOC_MIME) {
      html = await readLegacyWordDocumentHtml(bytes)
    } else if (extension === 'odt' || mime === ODT_MIME) {
      html = await readOpenDocumentTextHtml(bytes)
    } else if (extension === 'pptx' || mime === PPTX_MIME) {
      html = await readPptxDocumentHtml(bytes)
    }
    const trimmed = html?.trim() ?? ''
    if (!trimmed || trimmed.length > MAX_PREVIEW_CHARACTERS) return null
    return trimmed
  } catch (error) {
    Logger.error(`Failed to render document ${documentAttachmentLabel(attachment)}:`, error)
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
