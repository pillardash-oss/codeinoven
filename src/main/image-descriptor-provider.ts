/// <reference types="node" />

import { readFile, stat, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PromptAttachment } from '../lib/types'
import {
  IMAGE_DESCRIPTOR_MAX_IMAGES,
  type ImageDescriptorEntry,
  type ImageDescriptorSourceType
} from '../lib/image-descriptor'

export {
  IMAGE_DESCRIPTOR_INPUT_SCHEMA,
  IMAGE_DESCRIPTOR_OUTPUT_SCHEMA,
  IMAGE_DESCRIPTOR_PROMPT,
  IMAGE_DESCRIPTOR_TOOL_NAME,
  type ImageDescriptorEntry,
  type ImageDescriptorSourceType
} from '../lib/image-descriptor'

/** A requested image resolved to a harness-ready prompt attachment. */
export interface ResolvedImageEntry extends ImageDescriptorEntry {
  attachment: PromptAttachment
}

/** One description tagged to the entry id that requested it. */
export interface ImageDescriptorResult {
  id: string
  source: string
  type: ImageDescriptorSourceType
  description: string
  error?: string
}

/** Model selection shape used to pin the vision model. */
export interface ImageDescriptorModelSelection {
  harnessId: string
  providerId: string
  modelId: string
}

/** Request context the vision executor needs to route a harness session. */
export interface ImageDescriptorExecutorRequest {
  images: ResolvedImageEntry[]
  projectId: string
  threadId: string
  projectPath: string
  /** Main thread session that invoked the tool, for user-decision events. */
  sessionId: string
  /** Vision model pinned by a configured image-descriptor utility, if any. */
  pinnedSelection?: ImageDescriptorModelSelection
}

/** Executes the vision model call. Supplied by the chat engine. */
export type ImageDescriptorExecutor = (
  request: ImageDescriptorExecutorRequest
) => Promise<ImageDescriptorResult[]>

const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/**
 * Validate the model-provided image entries and resolve each source into a
 * harness-ready prompt attachment (a local path, data URL, or remote URL).
 */
export function resolveImageEntries(value: unknown): ResolvedImageEntry[] {
  if (!isRecord(value)) throw new TypeError('Image descriptor input must be an object')
  const images = value['images']
  if (
    !Array.isArray(images) ||
    images.length === 0 ||
    images.length > IMAGE_DESCRIPTOR_MAX_IMAGES
  ) {
    throw new TypeError(
      `Image descriptor input must contain between 1 and ${IMAGE_DESCRIPTOR_MAX_IMAGES} images`
    )
  }
  const ids = new Set<string>()
  return images.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`Image entry ${index} must be an object`)
    const id = requiredString(entry['id'], `Image entry ${index} id`, 256)
    if (ids.has(id)) throw new TypeError(`Duplicate image entry id: ${id}`)
    ids.add(id)
    const type = entry['type']
    if (type !== 'path' && type !== 'binary') {
      throw new TypeError(`Image entry ${index} type must be "path" or "binary"`)
    }
    const source = requiredString(entry['source'], `Image entry ${index} source`, 20_000)
    const resolved: ResolvedImageEntry = {
      id,
      source,
      type,
      attachment: resolveAttachment(source, type)
    }
    return resolved
  })
}

function resolveAttachment(source: string, type: ImageDescriptorSourceType): PromptAttachment {
  if (type === 'binary') {
    return {
      mime: dataUrlMime(source) ?? sniffImageMime(source) ?? 'image/png',
      url: toDataUrl(source)
    }
  }
  if (source.startsWith('data:')) return { mime: dataUrlMime(source) ?? 'image/*', url: source }
  if (/^https?:\/\//u.test(source)) return { mime: 'image/*', url: source }
  const filePath = source.startsWith('file:') ? fileURLToPath(source) : source
  return {
    mime: mimeFromPath(filePath),
    url: pathToFileUrl(filePath),
    filename: basename(filePath)
  }
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathToFileUrl(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

function mimeFromPath(path: string): string {
  const known: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif'
  }
  return known[extname(path).toLowerCase()] ?? 'image/*'
}

function dataUrlMime(source: string): string | undefined {
  if (!source.startsWith('data:')) return undefined
  const comma = source.indexOf(',')
  if (comma === -1) return undefined
  const header = source.slice(5, comma)
  const mime = header.split(';')[0]
  return mime || undefined
}

function toDataUrl(source: string): string {
  if (source.startsWith('data:')) return source
  const mime = sniffImageMime(source) ?? 'image/png'
  return `data:${mime};base64,${source}`
}

/** Best-effort mime detection from base64 image magic bytes. */
function sniffImageMime(base64: string): string | undefined {
  return sniffImageMagic(Buffer.from(base64.slice(0, 32), 'base64'))
}

/** Best-effort mime detection from the first bytes of an image buffer. */
function sniffImageMagic(buffer: Buffer): string | undefined {
  try {
    if (buffer.length < 8) return undefined
    const magic = [...buffer.subarray(0, 8)]
    if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47) {
      return 'image/png'
    }
    if (magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) return 'image/jpeg'
    if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) return 'image/gif'
    if (magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46) {
      return 'image/webp'
    }
    if (magic[0] === 0x42 && magic[1] === 0x4d) return 'image/bmp'
    if (magic[0] === 0x3c) return 'image/svg+xml'
    return undefined
  } catch {
    return undefined
  }
}

/** Verify a local path source is a readable, bounded file. Throws when not. */
export async function assertReadablePartSource(entry: ResolvedImageEntry): Promise<void> {
  if (entry.type !== 'path' || entry.attachment.url.startsWith('data:')) return
  if (/^https?:\/\//u.test(entry.attachment.url)) return
  const path = await resolveReadablePartPath(entry)
  if (!path) {
    throw new Error(`Image descriptor source is not a readable file: ${entry.source}`)
  }
  let details
  try {
    details = await stat(path)
  } catch {
    throw new Error(`Image descriptor source is not a readable file: ${entry.source}`)
  }
  if (!details.isFile()) throw new Error(`Image descriptor source is not a file: ${entry.source}`)
  if (details.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image descriptor source exceeds the 16 MiB limit: ${entry.source}`)
  }
}

/**
 * Resolve a local `path` source to a readable path. macOS screenshot names use a
 * non-breaking space (U+00A0) between the time and AM/PM; a model echoing the path
 * back into a tool call often normalizes it to a regular space (U+0020), so the
 * exact path can be absent while the file exists. When the exact path is missing,
 * scan the parent directory for a sibling whose name matches after whitespace
 * normalization.
 */
export async function resolveReadablePartPath(entry: ResolvedImageEntry): Promise<string | null> {
  if (entry.type !== 'path' || entry.attachment.url.startsWith('data:')) return null
  if (/^https?:\/\//u.test(entry.attachment.url)) return null
  const exact = entry.attachment.url.startsWith('file://')
    ? fileURLToPath(entry.attachment.url)
    : entry.attachment.url
  try {
    const details = await stat(exact)
    return details.isFile() ? exact : null
  } catch {
    // Fall through to the whitespace-tolerant lookup.
  }
  const wanted = normalizeFilenameSpaces(basename(exact))
  let entries: string[]
  try {
    entries = await readdir(dirname(exact))
  } catch {
    return null
  }
  const match = entries.find(
    (candidate) => normalizeFilenameSpaces(candidate) === wanted && candidate !== basename(exact)
  )
  return match ? join(dirname(exact), match) : null
}

/** Collapse non-breaking spaces and other Unicode whitespace to U+0020. */
function normalizeFilenameSpaces(name: string): string {
  return name.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000\s]/gu, ' ')
}

/** Read a local path source into a data URL when the harness cannot fetch it. */
export async function readPartSourceBytes(entry: ResolvedImageEntry): Promise<Buffer | null> {
  if (entry.type !== 'path' || entry.attachment.url.startsWith('data:')) return null
  if (/^https?:\/\//u.test(entry.attachment.url)) return null
  const path = await resolveReadablePartPath(entry)
  if (!path) return null
  return readFile(path)
}

/**
 * Resolve a local `path` source into a self-contained data-URL attachment by
 * reading its bytes in the main process. This keeps the vision session from
 * re-reading the original file path — essential for transient sources (temp
 * screenshots, pasted images) that may be deleted before the harness resolves
 * the attachment. Remote `http(s)` and already-embedded `data:` sources are
 * returned unchanged (the harness fetches or decodes those itself). An
 * unresolvable local file throws a clear error instead of handing the vision
 * session a dead file URL.
 */
export async function resolveSelfContainedAttachment(
  entry: ResolvedImageEntry
): Promise<PromptAttachment> {
  if (entry.type !== 'path' || entry.attachment.url.startsWith('data:')) {
    return entry.attachment
  }
  if (/^https?:\/\//u.test(entry.attachment.url)) return entry.attachment
  const path = await resolveReadablePartPath(entry)
  if (!path) {
    throw new Error(
      `Image descriptor source is not a readable file: ${entry.source}. The file may have been moved, renamed, or deleted.`
    )
  }
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(
      `Image descriptor source could not be read: ${entry.source}. ${error instanceof Error ? error.message : 'Unknown read error'}`,
      { cause: error }
    )
  }
  const mime =
    entry.attachment.mime === 'image/*'
      ? (sniffImageMagic(bytes.subarray(0, 32)) ?? 'image/png')
      : entry.attachment.mime
  return {
    mime,
    url: `data:${mime};base64,${bytes.toString('base64')}`,
    filename: entry.attachment.filename
  }
}
