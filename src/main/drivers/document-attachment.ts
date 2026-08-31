/// <reference types="node" />

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Logger } from '../system/logger'
import type { PromptAttachment } from '../../lib/types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const ODT_MIME = 'application/vnd.oasis.opendocument.text'
const DOC_MIME = 'application/msword'
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_EXTRACTED_CHARACTERS = 200_000
const MAX_PREVIEW_CHARACTERS = 4_000_000

/** The document formats this module can extract content from. */
type DocumentKind = 'docx' | 'doc' | 'odt' | 'pptx'

function documentAttachmentLabel(attachment: PromptAttachment): string {
  return (attachment.filename ?? attachment.url).replace(/[\r\n]+/gu, ' ')
}

function documentExtension(attachment: PromptAttachment): string {
  const source = attachment.filename ?? attachment.url
  const withoutQuery = source.split(/[?#]/u, 1)[0] ?? ''
  const dot = withoutQuery.lastIndexOf('.')
  return dot < 0 ? '' : withoutQuery.slice(dot + 1).toLowerCase()
}

/** Resolve the document kind from the mime type first, falling back to the
 *  filename extension (many sources report `application/octet-stream`). */
function documentKind(attachment: PromptAttachment): DocumentKind | null {
  const mime = attachment.mime.toLowerCase().split(';', 1)[0] ?? ''
  if (mime === DOCX_MIME) return 'docx'
  if (mime === DOC_MIME) return 'doc'
  if (mime === ODT_MIME) return 'odt'
  if (mime === PPTX_MIME) return 'pptx'
  const extension = documentExtension(attachment)
  if (extension === 'docx' || extension === 'doc' || extension === 'odt' || extension === 'pptx') {
    return extension
  }
  return null
}

/** True when an attachment is a document with extractable content (DOCX,
 *  legacy DOC, ODT, PPTX). */
export function isDocumentAttachment(attachment: PromptAttachment): boolean {
  return documentKind(attachment) !== null
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
    return bytes.byteLength <= MAX_DOCUMENT_BYTES ? bytes : null
  }
  if (/^https?:\/\//u.test(attachment.url)) return null

  const path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  const details = await stat(path)
  if (!details.isFile() || details.size > MAX_DOCUMENT_BYTES) return null
  return readFile(path)
}

function boundDocumentText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_EXTRACTED_CHARACTERS) return trimmed
  const omitted = trimmed.length - MAX_EXTRACTED_CHARACTERS
  return `${trimmed.slice(0, MAX_EXTRACTED_CHARACTERS)}\n\n[Document truncated: ${omitted.toLocaleString('en-US')} additional characters omitted.]`
}

// ─── DOCX ────────────────────────────────────────────────────────────────────

async function readModernWordDocumentHtml(bytes: Buffer): Promise<string | null> {
  const mammoth = (await import('mammoth')).default
  const result = await mammoth.convertToHtml({ buffer: bytes })
  const html = result.value.trim()
  return html || null
}

async function readModernWordDocumentText(bytes: Buffer): Promise<string | null> {
  const mammoth = (await import('mammoth')).default
  const result = await mammoth.extractRawText({ buffer: bytes })
  return result.value || null
}

// ─── Legacy DOC ──────────────────────────────────────────────────────────────

interface LegacyWordContent {
  paragraphs: string[]
}

/** Legacy binary `.doc`: extract plain text via word-extractor. Formatting is
 *  not recoverable from the OLE container. */
async function readLegacyWordDocument(bytes: Buffer): Promise<LegacyWordContent | null> {
  const WordExtractor = (await import('word-extractor')).default
  const extracted = await new WordExtractor().extract(bytes)
  const body = extracted.getBody()
  if (!body.trim()) return null
  return { paragraphs: body.split(/\r\n|\r|\n/u) }
}

function legacyWordToHtml(content: LegacyWordContent): string | null {
  const html = paragraphsToHtml(content.paragraphs)
  return html || null
}

function legacyWordToText(content: LegacyWordContent): string | null {
  const text = content.paragraphs
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n')
  return text || null
}

// ─── ODT ─────────────────────────────────────────────────────────────────────

type OdtBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: OdtBlock[] }

const ODF_TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
const ODF_OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'

/** ODT: parse `content.xml` into headings, paragraphs, and nested lists.
 *  Inline character formatting is flattened to plain text. */
async function readOpenDocumentBlocks(bytes: Buffer): Promise<OdtBlock[] | null> {
  const { default: JSZip } = await import('jszip')
  const { DOMParser } = await import('@xmldom/xmldom')
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file('content.xml')
  if (!entry) return null
  const xml = await entry.async('string')
  const parsed = new DOMParser().parseFromString(xml, 'text/xml')

  function collectBlocks(container: Node, out: OdtBlock[]): void {
    for (let i = 0; i < container.childNodes.length; i += 1) {
      const node = container.childNodes.item(i)
      if (node.nodeType !== node.ELEMENT_NODE) continue
      const element = node as Element
      if (element.localName === 'h') {
        const level = Math.min(
          Math.max(Number(element.getAttributeNS(ODF_TEXT_NS, 'outline-level')) || 1, 1),
          6
        )
        const text = (element.textContent ?? '').trim()
        if (text) out.push({ type: 'heading', level, text })
      } else if (element.localName === 'p') {
        const text = (element.textContent ?? '').trim()
        if (text) out.push({ type: 'paragraph', text })
      } else if (element.localName === 'list') {
        const items: OdtBlock[] = []
        collectListItems(element, items)
        if (items.length > 0) out.push({ type: 'list', items })
      } else {
        collectBlocks(element, out)
      }
    }
  }

  function collectListItems(list: Element, out: OdtBlock[]): void {
    for (let i = 0; i < list.childNodes.length; i += 1) {
      const child = list.childNodes.item(i)
      if (child.nodeType !== child.ELEMENT_NODE) continue
      const element = child as Element
      if (element.localName !== 'list-item') continue
      const itemBlocks: OdtBlock[] = []
      collectBlocks(element, itemBlocks)
      out.push(...itemBlocks)
    }
  }

  const body = parsed.getElementsByTagNameNS(ODF_OFFICE_NS, 'text').item(0)
  if (!body) return null
  const blocks: OdtBlock[] = []
  collectBlocks(body, blocks)
  return blocks.length > 0 ? blocks : null
}

function odtBlockHtml(block: OdtBlock): string[] {
  if (block.type === 'heading') {
    return [`<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`]
  }
  if (block.type === 'paragraph') {
    return [`<p>${escapeHtml(block.text)}</p>`]
  }
  const items = block.items
    .map((item) => {
      const inner = odtBlockHtml(item)
      const [first, ...rest] = inner
      return [`<li>${first ?? ''}${rest.join('')}</li>`]
    })
    .map((lines) => lines.join(''))
  return [`<ul>\n${items.join('\n')}\n</ul>`]
}

function odtBlocksToHtml(blocks: readonly OdtBlock[]): string {
  return blocks.flatMap((block) => odtBlockHtml(block)).join('\n')
}

function odtBlocksToText(blocks: readonly OdtBlock[], depth = 0): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  for (const block of blocks) {
    if (block.type === 'list') {
      lines.push(...odtBlocksToText(block.items, depth + 1))
    } else {
      lines.push(`${indent}${block.text}`)
    }
  }
  return lines
}

// ─── PPTX ────────────────────────────────────────────────────────────────────

interface PptxSlide {
  /** Title placeholder text, or null when the slide has no title shape. */
  title: string | null
  /** Body paragraph lines (all non-title shapes, in shape order). */
  paragraphs: string[]
}

interface PptxShape {
  title: boolean
  paragraphs: string[]
}

function parsePptxShape(shape: Element): PptxShape | null {
  const placeholder = shape.getElementsByTagName('p:ph').item(0)
  const placeholderType = placeholder?.getAttribute('type') ?? ''
  const title = placeholderType === 'title' || placeholderType === 'ctrTitle'
  const paragraphs: string[] = []
  const paragraphNodes = shape.getElementsByTagName('a:p')
  for (let i = 0; i < paragraphNodes.length; i += 1) {
    const paragraph = paragraphNodes.item(i) as Element
    const runNodes = paragraph.getElementsByTagName('a:t')
    const runs: string[] = []
    for (let j = 0; j < runNodes.length; j += 1) {
      runs.push(runNodes.item(j)?.textContent ?? '')
    }
    const text = runs.join('').trim()
    if (text) paragraphs.push(text)
  }
  if (paragraphs.length === 0) return null
  return { title, paragraphs }
}

/** PPTX: read slides in deck order (slide text only — images and charts are
 *  omitted). */
async function readPptxSlides(bytes: Buffer): Promise<PptxSlide[] | null> {
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

  const slides: PptxSlide[] = []
  for (const number of slideNumbers) {
    const entry = zip.file(`ppt/slides/slide${number}.xml`)
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
    slides.push({
      title: titleShape ? titleShape.paragraphs.join(' ') : null,
      paragraphs: bodyShapes.flatMap((shape) => shape.paragraphs)
    })
  }
  return slides.length > 0 ? slides : null
}

function pptxSlidesToHtml(slides: readonly PptxSlide[]): string | null {
  const sections: string[] = []
  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index]
    if (!slide.title && slide.paragraphs.length === 0) continue
    const body: string[] = [
      `<h2>${escapeHtml(slide.title ?? `Slide ${index + 1}`)}</h2>`,
      ...paragraphsToHtml(slide.paragraphs).split('\n')
    ]
    sections.push(`<section>\n${body.filter((line) => line.length > 0).join('\n')}\n</section>`)
  }
  const html = sections.join('\n<hr>\n')
  return html || null
}

function pptxSlidesToText(slides: readonly PptxSlide[]): string | null {
  const lines: string[] = []
  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index]
    if (!slide.title && slide.paragraphs.length === 0) continue
    lines.push(`[Slide ${index + 1}]${slide.title ? ` ${slide.title}` : ''}`)
    lines.push(...slide.paragraphs)
    lines.push('')
  }
  const text = lines.join('\n').trim()
  return text || null
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract model-readable text from a supported document attachment (DOCX,
 * legacy DOC, ODT, PPTX). Returns null when the source is unavailable,
 * oversized, invalid, or contains no readable text.
 */
export async function readDocumentText(attachment: PromptAttachment): Promise<string | null> {
  const kind = documentKind(attachment)
  if (!kind) return null
  try {
    const bytes = await documentAttachmentBytes(attachment)
    if (!bytes) return null
    let text: string | null = null
    if (kind === 'docx') {
      text = await readModernWordDocumentText(bytes)
    } else if (kind === 'doc') {
      const content = await readLegacyWordDocument(bytes)
      text = content ? legacyWordToText(content) : null
    } else if (kind === 'odt') {
      const blocks = await readOpenDocumentBlocks(bytes)
      text = blocks ? odtBlocksToText(blocks).join('\n') : null
    } else {
      const slides = await readPptxSlides(bytes)
      text = slides ? pptxSlidesToText(slides) : null
    }
    return boundDocumentText(text ?? '') || null
  } catch (error) {
    Logger.error(`Failed to extract document ${documentAttachmentLabel(attachment)}:`, error)
    return null
  }
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
    const kind = documentKind(attachment)
    let html: string | null = null
    if (kind === 'docx') {
      html = await readModernWordDocumentHtml(bytes)
    } else if (kind === 'doc') {
      const content = await readLegacyWordDocument(bytes)
      html = content ? legacyWordToHtml(content) : null
    } else if (kind === 'odt') {
      const blocks = await readOpenDocumentBlocks(bytes)
      html = blocks ? odtBlocksToHtml(blocks) : null
    } else if (kind === 'pptx') {
      const slides = await readPptxSlides(bytes)
      html = slides ? pptxSlidesToHtml(slides) : null
    }
    const trimmed = html?.trim() ?? ''
    if (!trimmed || trimmed.length > MAX_PREVIEW_CHARACTERS) return null
    return trimmed
  } catch (error) {
    Logger.error(`Failed to render document ${documentAttachmentLabel(attachment)}:`, error)
    return null
  }
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
