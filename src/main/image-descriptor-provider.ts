/// <reference types="node" />

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PromptAttachment } from '../lib/types'

/** How the image source should be interpreted. */
export type ImageDescriptorSourceType = 'part' | 'binary'

/** One image requested for description. `source` is a file path / file URL /
 *  http(s) URL / data URL when `type` is `part`, or base64 (or a data URL)
 *  when `type` is `binary`. Each entry carries a unique `id` so responses can
 *  be mapped back to the request. */
export interface ImageDescriptorEntry {
  id: string
  source: string
  type: ImageDescriptorSourceType
}

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
  /** Vision model pinned by a configured image-descriptor utility, if any. */
  pinnedSelection?: ImageDescriptorModelSelection
}

/** Executes the vision model call. Supplied by the chat engine. */
export type ImageDescriptorExecutor = (
  request: ImageDescriptorExecutorRequest
) => Promise<ImageDescriptorResult[]>

const MAX_IMAGE_COUNT = 8
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/** Exhaustive description instruction given to the vision model. */
export const IMAGE_DESCRIPTOR_PROMPT =
  'Describe this image exhaustively, in a structured reading order from the top-left corner to the bottom-right corner across the entire image, so that another model can use this description for a mission-critical operation. Ensure no detail is skipped. Describe every single thing that you can identify: layout, subjects and objects, people, actions, text verbatim, colors, spatial relationships, textures, lighting, and any anomalies or edges.'

export const IMAGE_DESCRIPTOR_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description:
    'Describe one or more images using a vision-capable model so a text-only model can reason about them. Provide every image entry with a unique id.',
  properties: {
    images: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_IMAGE_COUNT,
      description:
        'Images to describe. Each entry has a unique id, a source, and a type: "part" when source is a file path or URL the model can read, or "binary" when source is base64 image data.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'Unique id used to tag this entry in the response.'
          },
          source: {
            type: 'string',
            minLength: 1,
            description:
              'File path, file:// URL, http(s) URL, or data URL when type is "part"; base64 image data or a data URL when type is "binary".'
          },
          type: {
            type: 'string',
            enum: ['part', 'binary'],
            description:
              'How to read the source: "part" reads it as a file/URL reference, "binary" decodes it as base64 image data.'
          }
        },
        required: ['id', 'source', 'type']
      }
    }
  },
  required: ['images']
}

export const IMAGE_DESCRIPTOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          type: { type: 'string', enum: ['part', 'binary'] },
          description: { type: 'string' },
          error: { type: 'string' }
        },
        required: ['id', 'source', 'type', 'description']
      }
    }
  },
  required: ['results']
}

/**
 * Validate the model-provided image entries and resolve each source into a
 * harness-ready prompt attachment (a local path, data URL, or remote URL).
 */
export function resolveImageEntries(value: unknown): ResolvedImageEntry[] {
  if (!isRecord(value)) throw new TypeError('Image descriptor input must be an object')
  const images = value['images']
  if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGE_COUNT) {
    throw new TypeError(
      `Image descriptor input must contain between 1 and ${MAX_IMAGE_COUNT} images`
    )
  }
  const ids = new Set<string>()
  return images.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`Image entry ${index} must be an object`)
    const id = requiredString(entry['id'], `Image entry ${index} id`, 256)
    if (ids.has(id)) throw new TypeError(`Duplicate image entry id: ${id}`)
    ids.add(id)
    const type = entry['type']
    if (type !== 'part' && type !== 'binary') {
      throw new TypeError(`Image entry ${index} type must be "part" or "binary"`)
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
  try {
    const buffer = Buffer.from(base64.slice(0, 32), 'base64')
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

/** Verify a local part source is a readable, bounded file. Throws when not. */
export async function assertReadablePartSource(entry: ResolvedImageEntry): Promise<void> {
  if (entry.type !== 'part' || entry.attachment.url.startsWith('data:')) return
  if (/^https?:\/\//u.test(entry.attachment.url)) return
  const path = entry.attachment.url.startsWith('file://')
    ? fileURLToPath(entry.attachment.url)
    : entry.attachment.url
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

/** Read a local part source into a data URL when the harness cannot fetch it. */
export async function readPartSourceBytes(entry: ResolvedImageEntry): Promise<Buffer | null> {
  if (entry.type !== 'part' || entry.attachment.url.startsWith('data:')) return null
  if (/^https?:\/\//u.test(entry.attachment.url)) return null
  const path = entry.attachment.url.startsWith('file://')
    ? fileURLToPath(entry.attachment.url)
    : entry.attachment.url
  return readFile(path)
}
