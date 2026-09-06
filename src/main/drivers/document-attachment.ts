/// <reference types="node" />

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Logger } from '../system/logger'
import type { PromptAttachment } from '../../lib/types'
import type JSZip from 'jszip'
import type { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const ODT_MIME = 'application/vnd.oasis.opendocument.text'
const DOC_MIME = 'application/msword'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS_MIME = 'application/vnd.ms-excel'
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet'
const CSV_MIME = 'text/csv'
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_EXTRACTED_CHARACTERS = 200_000
const MAX_PREVIEW_CHARACTERS = 4_000_000
/** Maximum sheet rows rendered per sheet and sheets rendered per workbook —
 *  keeps untrusted-workbook HTML inside the preview budget. */
const MAX_SHEET_ROWS = 5_000
const MAX_SHEET_COLUMNS = 200
const MAX_SHEETS = 30

/** The document formats this module can extract content from. */
type DocumentKind = 'docx' | 'doc' | 'odt' | 'pptx' | 'xlsx' | 'xls' | 'ods' | 'csv'

function documentAttachmentLabel(attachment: PromptAttachment): string {
  return (attachment.filename ?? attachment.url).replace(/[\r\n]+/gu, ' ')
}

function documentExtension(attachment: PromptAttachment): string {
  const source = attachment.filename ?? attachment.url
  const withoutQuery = source.split(/[?#]/u, 1)[0] ?? ''
  const dot = withoutQuery.lastIndexOf('.')
  return dot < 0 ? '' : withoutQuery.slice(dot + 1).toLowerCase()
}

function extensionIsTsv(attachment: PromptAttachment): boolean {
  return documentExtension(attachment) === 'tsv'
}

/** Resolve the document kind from the mime type first, falling back to the
 *  filename extension (many sources report `application/octet-stream`). */
function documentKind(attachment: PromptAttachment): DocumentKind | null {
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

// ─── Spreadsheets (XLSX, legacy XLS, ODS, CSV/TSV) ─────────────────────────

interface SheetTable {
  name: string
  rows: string[][]
}

interface Workbook {
  sheets: SheetTable[]
  /** True when any sheet was truncated (row, column, or sheet count caps). */
  truncated: boolean
}

function sheetTableToHtml(table: SheetTable): string {
  const sections: string[] = [`<h2>${escapeHtml(table.name)}</h2>`]
  if (table.rows.length === 0) {
    sections.push('<p>(empty sheet)</p>')
    return sections.join('\n')
  }
  const [header, ...body] = table.rows
  const head = header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')
  const rows = body
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n')
  sections.push(`<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`)
  return sections.join('\n')
}

function workbookToHtml(workbook: Workbook): string {
  const sections = workbook.sheets.map(sheetTableToHtml)
  if (workbook.truncated) {
    sections.push(
      '<p><em>(Preview truncated: the workbook exceeded the preview row, column, or sheet limits.)</em></p>'
    )
  }
  return sections.join('\n<hr>\n')
}

function workbookToText(workbook: Workbook): string {
  const lines: string[] = []
  for (const sheet of workbook.sheets) {
    lines.push(`[Sheet: ${sheet.name}]`)
    for (const row of sheet.rows) lines.push(row.map((cell) => cell.trim()).join('\t'))
    lines.push('')
  }
  if (workbook.truncated) {
    lines.push(
      '[Preview truncated: the workbook exceeded the preview row, column, or sheet limits.]'
    )
  }
  return lines.join('\n').trim()
}

/** Cap a raw sheet grid to the preview limits, dropping fully-empty trailing
 *  rows/columns first so blank padding does not consume the budget. */
function boundSheet(name: string, rows: string[][]): { table: SheetTable; truncated: boolean } {
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell.trim() === '')) rows.pop()
  while (rows.length > 0 && rows[0]!.every((cell) => cell.trim() === '')) rows.shift()
  let width = 0
  for (const row of rows) {
    let last = row.length
    while (last > 0 && row[last - 1]!.trim() === '') last -= 1
    if (last > width) width = last
  }
  const truncatedRows = rows.length > MAX_SHEET_ROWS
  const truncatedColumns = width > MAX_SHEET_COLUMNS
  const bounded = rows.slice(0, MAX_SHEET_ROWS).map((row) => row.slice(0, MAX_SHEET_COLUMNS))
  return {
    table: { name, rows: bounded },
    truncated: truncatedRows || truncatedColumns
  }
}

/** XLSX / legacy XLS / ODS via SheetJS (supports all three). CSV/TSV are
 *  parsed natively to keep delimited text independent of the workbook parser. */
async function readWorkbook(
  bytes: Buffer,
  kind: 'xlsx' | 'xls' | 'ods' | 'csv',
  tsv: boolean
): Promise<Workbook | null> {
  if (kind === 'csv') {
    const delimiter = tsv ? '\t' : ','
    const text = bytes.toString('utf8')
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let inQuotes = false
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 1
          } else {
            inQuotes = false
          }
        } else {
          field += char
        }
      } else if (char === '"') {
        inQuotes = true
      } else if (char === delimiter) {
        row.push(field)
        field = ''
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1
        row.push(field)
        field = ''
        rows.push(row)
        row = []
      } else {
        field += char
      }
    }
    if (field !== '' || row.length > 0) {
      row.push(field)
      rows.push(row)
    }
    const bound = boundSheet('Sheet 1', rows)
    return { sheets: [bound.table], truncated: bound.truncated }
  }

  const XLSX = await import('xlsx')
  const parsed = XLSX.read(bytes, { type: 'buffer', dense: false, cellDates: false })
  const sheetNames = parsed.SheetNames.slice(0, MAX_SHEETS)
  const sheets: SheetTable[] = []
  let truncated = parsed.SheetNames.length > MAX_SHEETS
  for (const name of sheetNames) {
    const grid = XLSX.utils.sheet_to_json<string[]>(parsed.Sheets[name]!, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true
    })
    const bound = boundSheet(
      name,
      grid.map((row) => [...row])
    )
    sheets.push(bound.table)
    if (bound.truncated) truncated = true
  }
  return sheets.length > 0 ? { sheets, truncated } : null
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

  function collectBlocks(container: XmlNode, out: OdtBlock[]): void {
    for (let i = 0; i < container.childNodes.length; i += 1) {
      const node = container.childNodes.item(i)
      if (!node || node.nodeType !== node.ELEMENT_NODE) continue
      const element = node as XmlElement
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

  function collectListItems(list: XmlElement, out: OdtBlock[]): void {
    for (let i = 0; i < list.childNodes.length; i += 1) {
      const child = list.childNodes.item(i)
      if (!child || child.nodeType !== child.ELEMENT_NODE) continue
      const element = child as XmlElement
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

// ─── PPTX ──────────────────────────────────────────────────────────────

/** Raw image budget for one deck: images above these caps are skipped so a
 *  media-heavy deck cannot blow the preview size or renderer memory. */
const MAX_PPTX_IMAGE_BYTES = 512 * 1024
const MAX_PPTX_TOTAL_IMAGE_BYTES = 1536 * 1024
const MAX_PPTX_IMAGES = 20
/** EMU per point (914400 per inch / 72). */
const EMU_PER_PT = 12700
const PPTX_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

interface PptxTextRun {
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  /** Font size in points, or null for inherited default. */
  sizePt: number | null
  /** `#rrggbb` color, or null for inherited default. */
  color: string | null
}

interface PptxParagraph {
  runs: PptxTextRun[]
  /** DrawingML alignment (`l`, `ctr`, `r`, `just`), or null. */
  align: string | null
  /** Bullet indent level (0-based). */
  level: number
}

/** Shape box in EMU; null members fall back to flow layout. */
interface PptxBox {
  x: number | null
  y: number | null
  cx: number | null
  cy: number | null
}

interface PptxShape {
  box: PptxBox
  paragraphs: PptxParagraph[]
  /** Data-URI image fill (picture shapes), or null for text shapes. */
  image: string | null
}

interface PptxSlideBackground {
  color: string | null
  image: string | null
}

interface PptxSlide {
  background: PptxSlideBackground
  shapes: PptxShape[]
}

interface PptxDeck {
  /** Slide canvas size in EMU (from `p:sldSz`). */
  cx: number
  cy: number
  slides: PptxSlide[]
}

function pptxXmlAttribute(element: XmlElement, name: string): string | null {
  const value = element.getAttribute(name)
  return value === '' || value === null ? null : value
}

function pptxEmbeddedId(element: XmlElement): string | null {
  return (
    pptxXmlAttribute(element, 'r:embed') ??
    element.getAttributeNS(PPTX_REL_NS, 'embed') ??
    null
  )
}

/** Convert EMU to a percentage of the slide canvas, rounded to 2 decimals. */
function emuToPercent(emu: number, total: number): number {
  return Math.round((emu / total) * 10000) / 100
}

function pptxSolidFillHex(container: XmlElement): string | null {
  const fills = container.getElementsByTagName('a:solidFill')
  for (let i = 0; i < fills.length; i += 1) {
    const srgb = (fills.item(i) as XmlElement).getElementsByTagName('a:srgbClr').item(0)
    const value = srgb?.getAttribute('val')
    if (value && /^[0-9a-fA-F]{6}$/u.test(value)) return `#${value.toLowerCase()}`
  }
  return null
}

function parsePptxRuns(paragraph: XmlElement): PptxTextRun[] {
  const runs: PptxTextRun[] = []
  const runNodes = paragraph.getElementsByTagName('a:r')
  for (let i = 0; i < runNodes.length; i += 1) {
    const run = runNodes.item(i) as XmlElement
    const text = run.getElementsByTagName('a:t').item(0)?.textContent ?? ''
    if (!text) continue
    const props = run.getElementsByTagName('a:rPr').item(0) as XmlElement | null
    const sizeAttr = props?.getAttribute('sz') ?? null
    const sizePt = sizeAttr ? Number(sizeAttr) / 100 : null
    runs.push({
      text,
      bold: props?.getAttribute('b') === '1',
      italic: props?.getAttribute('i') === '1',
      underline: (props?.getAttribute('u') ?? '') !== 'none' && !!props?.getAttribute('u'),
      sizePt: sizePt !== null && Number.isFinite(sizePt) ? sizePt : null,
      color: props ? pptxSolidFillHex(props) : null
    })
  }
  return runs
}

function parsePptxParagraphs(shape: XmlElement): PptxParagraph[] {
  const paragraphs: PptxParagraph[] = []
  const paragraphNodes = shape.getElementsByTagName('a:p')
  for (let i = 0; i < paragraphNodes.length; i += 1) {
    const paragraph = paragraphNodes.item(i) as XmlElement
    const props = paragraph.getElementsByTagName('a:pPr').item(0) as XmlElement | null
    const runs = parsePptxRuns(paragraph)
    if (runs.length === 0) continue
    paragraphs.push({
      runs,
      align: props?.getAttribute('algn') ?? null,
      level: Math.min(Math.max(Number(props?.getAttribute('lvl') ?? 0) || 0, 0), 8)
    })
  }
  return paragraphs
}

/** Read `a:xfrm` position/extent, or null box when the shape has no explicit
 *  geometry (placeholder inheriting layout position). */
function parsePptxBox(shape: XmlElement): PptxBox {
  const xfrm = shape.getElementsByTagName('a:xfrm').item(0) as XmlElement | null
  if (!xfrm) return { x: null, y: null, cx: null, cy: null }
  const off = xfrm.getElementsByTagName('a:off').item(0) as XmlElement | null
  const ext = xfrm.getElementsByTagName('a:ext').item(0) as XmlElement | null
  const num = (value: string | null): number | null => {
    const parsed = value === null ? Number.NaN : Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    x: num(off?.getAttribute('x') ?? null),
    y: num(off?.getAttribute('y') ?? null),
    cx: num(ext?.getAttribute('cx') ?? null),
    cy: num(ext?.getAttribute('cy') ?? null)
  }
}

interface PptxRels {
  /** Relationship id → zip path (e.g. `ppt/media/image3.png`). */
  targets: Map<string, string>
}

async function readPptxSlideRels(
  zip: JSZip,
  slideNumber: number
): Promise<PptxRels> {
  const targets = new Map<string, string>()
  const entry = zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)
  if (!entry) return { targets }
  const { DOMParser } = await import('@xmldom/xmldom')
  const xml = await entry.async('string')
  const parsed = new DOMParser().parseFromString(xml, 'text/xml')
  const relationships = parsed.getElementsByTagName('Relationship')
  for (let i = 0; i < relationships.length; i += 1) {
    const relationship = relationships.item(i) as XmlElement
    const id = relationship.getAttribute('Id')
    const target = relationship.getAttribute('Target')
    if (!id || !target) continue
    // Targets are relative to ppt/slides/ — normalize `../media/x` to a zip path.
    targets.set(id, `ppt/slides/${target}`.split('/').reduce<string[]>((acc, part) => {
      if (part === '..') acc.pop()
      else if (part !== '.' && part !== '') acc.push(part)
      return acc
    }, []).join('/'))
  }
  return { targets }
}

const PPTX_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

/** Read an embedded image as a bounded data URI, honoring the per-deck byte
 *  budget. Returns null when the image is missing, unsupported, or over budget. */
async function readPptxImageDataUri(
  zip: JSZip,
  rels: PptxRels,
  embedId: string | null,
  budget: { bytes: number; count: number }
): Promise<string | null> {
  if (!embedId || budget.count >= MAX_PPTX_IMAGES || budget.bytes <= 0) return null
  const path = rels.targets.get(embedId)
  if (!path) return null
  const entry = zip.file(path)
  if (!entry) return null
  const extension = (path.split('.').pop() ?? '').toLowerCase()
  const mime = PPTX_IMAGE_MIME_BY_EXTENSION[extension]
  if (!mime) return null
  const bytes = await entry.async('nodebuffer')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PPTX_IMAGE_BYTES) return null
  if (bytes.byteLength > budget.bytes) return null
  budget.bytes -= bytes.byteLength
  budget.count += 1
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** PPTX: parse the deck into positioned shapes with formatting and embedded
 *  images so the preview can render slide-like cards. Text-only extraction
 *  reuses the same model. */
async function readPptxDeck(bytes: Buffer): Promise<PptxDeck | null> {
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

  // Slide canvas size from ppt/presentation.xml (EMU); 16:9 default.
  let cx = 12192000
  let cy = 6858000
  const presentationEntry = zip.file('ppt/presentation.xml')
  if (presentationEntry) {
    const parsed = new DOMParser().parseFromString(await presentationEntry.async('string'), 'text/xml')
    const size = parsed.getElementsByTagName('p:sldSz').item(0) as XmlElement | null
    const width = Number(size?.getAttribute('cx') ?? '')
    const height = Number(size?.getAttribute('cy') ?? '')
    if (Number.isFinite(width) && width > 0) cx = width
    if (Number.isFinite(height) && height > 0) cy = height
  }

  const imageBudget = { bytes: MAX_PPTX_TOTAL_IMAGE_BYTES, count: 0 }
  const slides: PptxSlide[] = []
  for (const number of slideNumbers.slice(0, MAX_SHEETS)) {
    const entry = zip.file(`ppt/slides/slide${number}.xml`)
    if (!entry) continue
    const parsed = new DOMParser().parseFromString(await entry.async('string'), 'text/xml')
    const rels = await readPptxSlideRels(zip, number)

    // Background: solid color or picture fill.
    const background: PptxSlideBackground = { color: null, image: null }
    const bg = parsed.getElementsByTagName('p:bg').item(0) as XmlElement | null
    if (bg) {
      background.color = pptxSolidFillHex(bg)
      const blip = bg.getElementsByTagName('a:blip').item(0) as XmlElement | null
      background.image = blip
        ? await readPptxImageDataUri(zip, rels, pptxEmbeddedId(blip), imageBudget)
        : null
    }

    const shapes: PptxShape[] = []
    // Document order over text shapes and picture shapes.
    const spNodes = parsed.getElementsByTagName('p:sp')
    for (let i = 0; i < spNodes.length; i += 1) {
      const paragraphs = parsePptxParagraphs(spNodes.item(i) as XmlElement)
      if (paragraphs.length === 0) continue
      shapes.push({ box: parsePptxBox(spNodes.item(i) as XmlElement), paragraphs, image: null })
    }
    const picNodes = parsed.getElementsByTagName('p:pic')
    for (let i = 0; i < picNodes.length; i += 1) {
      const pic = picNodes.item(i) as XmlElement
      const blip = pic.getElementsByTagName('a:blip').item(0) as XmlElement | null
      const image = blip
        ? await readPptxImageDataUri(zip, rels, pptxEmbeddedId(blip), imageBudget)
        : null
      if (image) shapes.push({ box: parsePptxBox(pic), paragraphs: [], image })
    }

    slides.push({ background, shapes })
  }
  return slides.length > 0 ? { cx, cy, slides } : null
}

function pptxParagraphToHtml(paragraph: PptxParagraph): string {
  const align =
    paragraph.align === 'ctr'
      ? 'center'
      : paragraph.align === 'r'
        ? 'right'
        : paragraph.align === 'just'
          ? 'justify'
          : null
  const inner = paragraph.runs
    .map((run) => {
      const styles: string[] = []
      if (run.bold) styles.push('font-weight:600')
      if (run.italic) styles.push('font-style:italic')
      if (run.underline) styles.push('text-decoration:underline')
      if (run.color) styles.push(`color:${run.color}`)
      const style = styles.length > 0 ? ` style="${escapeHtml(styles.join(';'))}"` : ''
      return `<span${style}>${escapeHtml(run.text)}</span>`
    })
    .join('')
  const declarations = [
    align ? `text-align:${align}` : null,
    paragraph.level > 0 ? `padding-left:${paragraph.level * 2.2}em` : null
  ].filter((value): value is string => value !== null)
  const style = declarations.length > 0 ? ` style="${escapeHtml(declarations.join(';'))}"` : ''
  return `<p${style}>${inner}</p>`
}

/** Render the deck as positioned 16:9-ish slide cards: absolute percent-based
 *  boxes over the slide canvas, text sized with container-query units so it
 *  scales with the pane, backgrounds, and embedded images. */
function pptxDeckToHtml(deck: PptxDeck): string | null {
  const widthPt = deck.cx / EMU_PER_PT
  if (widthPt <= 0) return null
  const sections: string[] = []
  for (let index = 0; index < deck.slides.length; index += 1) {
    const slide = deck.slides[index]
    const layers: string[] = []
    if (slide.background.image) {
      layers.push(
        `<div class="pptx-bg" style="background-image:url('${slide.background.image}')"></div>`
      )
    }
    const flow: string[] = []
    for (const shape of slide.shapes) {
      if (shape.image) {
        const img = `<img src="${shape.image}" alt="" />`
        const box = shape.box
        if (box.x !== null && box.y !== null && box.cx !== null && box.cy !== null) {
          layers.push(
            `<div class="pptx-shape" style="left:${emuToPercent(box.x, deck.cx)}%;top:${
              emuToPercent(box.y, deck.cy)
            }%;width:${emuToPercent(box.cx, deck.cx)}%;height:${
              emuToPercent(box.cy, deck.cy)
            }%">${img}</div>`
          )
        } else {
          flow.push(img)
        }
        continue
      }
      const content = shape.paragraphs.map(pptxParagraphToHtml).join('')
      const box = shape.box
      if (box.x !== null && box.y !== null && box.cx !== null) {
        layers.push(
          `<div class="pptx-text" style="left:${emuToPercent(box.x, deck.cx)}%;top:${
            emuToPercent(box.y, deck.cy)
          }%;width:${emuToPercent(box.cx, deck.cx)}%;${
            box.cy !== null ? `height:${emuToPercent(box.cy, deck.cy)}%;` : ''
          }">${content}</div>`
        )
      } else {
        flow.push(content)
      }
    }
    if (flow.length > 0) {
      layers.push(`<div class="pptx-text pptx-flow">${flow.join('')}</div>`)
    }
    const bgStyle = slide.background.color ? `background-color:${slide.background.color};` : ''
    sections.push(
      `<section class="pptx-slide" style="${bgStyle}aspect-ratio:${deck.cx}/${deck.cy}">` +
        `<span class="pptx-number">${index + 1}</span>${layers.join('\n')}\n</section>`
    )
  }
  const html = [
    '<style>',
    '.pptx-deck{display:flex;flex-direction:column;gap:1.5rem;align-items:center;}',
    '.pptx-slide{position:relative;width:100%;max-width:52rem;overflow:hidden;border-radius:.5rem;box-shadow:0 8px 30px rgb(0 0 0 / 18%);container-type:inline-size;background:#fff;}',
    '.pptx-slide .pptx-bg{position:absolute;inset:0;background-size:cover;background-position:center;}',
    '.pptx-slide .pptx-shape{position:absolute;}',
    '.pptx-slide .pptx-shape img{width:100%;height:100%;object-fit:contain;display:block;}',
    '.pptx-slide .pptx-text{position:absolute;overflow:hidden;color:#1f2430;}',
    '.pptx-slide .pptx-text p{margin:0 0 .35em;line-height:1.35;font-size:1.6cqw;}',
    '.pptx-slide .pptx-flow{position:static;padding:4cqw;color:#1f2430;}',
    '.pptx-slide .pptx-flow p{font-size:2cqw;}',
    '.pptx-slide .pptx-number{position:absolute;right:1.2cqw;bottom:.8cqw;font-size:1.4cqw;color:rgb(0 0 0 / 35%);}',
    '</style>',
    `<div class="pptx-deck">\n${sections.join('\n')}\n</div>`
  ].join('\n')
  return html
}

function pptxDeckToText(deck: PptxDeck): string | null {
  const lines: string[] = []
  for (let index = 0; index < deck.slides.length; index += 1) {
    const paragraphs = deck.slides[index].shapes.flatMap((shape) =>
      shape.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('').trim())
    )
    if (paragraphs.every((paragraph) => paragraph.length === 0)) continue
    lines.push(`[Slide ${index + 1}]`)
    lines.push(...paragraphs.filter((paragraph) => paragraph.length > 0))
    lines.push('')
  }
  const text = lines.join('\n').trim()
  return text || null
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract model-readable text from a supported document attachment (DOCX,
 * legacy DOC, ODT, PPTX, XLSX, legacy XLS, ODS, CSV/TSV). Returns null when
 * the source is unavailable, oversized, invalid, or contains no readable text.
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
    } else if (kind === 'pptx') {
      const deck = await readPptxDeck(bytes)
      text = deck ? pptxDeckToText(deck) : null
    } else if (kind === 'xlsx' || kind === 'xls' || kind === 'ods' || kind === 'csv') {
      const workbook = await readWorkbook(bytes, kind, kind === 'csv' && extensionIsTsv(attachment))
      text = workbook ? workbookToText(workbook) : null
    }
    return boundDocumentText(text ?? '') || null
  } catch (error) {
    Logger.error(`Failed to extract document ${documentAttachmentLabel(attachment)}:`, error)
    return null
  }
}

/**
 * Convert a supported document attachment (DOCX, legacy DOC, ODT, PPTX,
 * XLSX, legacy XLS, ODS, CSV/TSV) to bounded HTML for the attachment preview.
 * The renderer sanitizes and isolates this markup before displaying it.
 */
export async function readDocumentPreviewHtml(
  attachment: PromptAttachment
): Promise<string | null> {
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
      const deck = await readPptxDeck(bytes)
      html = deck ? pptxDeckToHtml(deck) : null
    } else if (kind === 'xlsx' || kind === 'xls' || kind === 'ods' || kind === 'csv') {
      const workbook = await readWorkbook(bytes, kind, kind === 'csv' && extensionIsTsv(attachment))
      html = workbook ? workbookToHtml(workbook) : null
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
