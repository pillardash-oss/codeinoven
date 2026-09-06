/// <reference types="node" />

import { stat, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateId } from '../../lib/utils'
import type { PromptAttachment } from '../../lib/types'
import {
  IMAGE_DESCRIPTOR_MAX_IMAGES,
  type ImageDescriptorEntry,
  type ImageDescriptorSourceType
} from '../../lib/image-descriptor'

export {
  IMAGE_DESCRIPTOR_INPUT_SCHEMA,
  IMAGE_DESCRIPTOR_OUTPUT_SCHEMA,
  IMAGE_DESCRIPTOR_PROMPT,
  IMAGE_DESCRIPTOR_TOOL_NAME,
  type ImageDescriptorEntry,
  type ImageDescriptorSourceType
} from '../../lib/image-descriptor'

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

/** Gates a harness must clear for a multi-image request to run as one call. */
export interface ImageDescriptorBatchCapability {
  /** Whether the harness can attach multiple images to a single vision request. */
  supportsBatch: boolean
  /** Maximum images the harness/provider accepts in one call. */
  maxImages: number
}

/** Whether a request runs as one structured call or falls back per image. */
export type ImageDescriptorBatchMode = 'batch' | 'sequential'

/** Why a request fell back to per-image vision calls. */
export type ImageDescriptorBatchFallbackReason = 'harness_does_not_batch' | 'too_many_images'

export interface ImageDescriptorBatchDecision {
  mode: ImageDescriptorBatchMode
  reason?: ImageDescriptorBatchFallbackReason
}

/**
 * Decide whether a multi-image request may be sent as one structured vision
 * call. Only harnesses that batch, and requests within the supported image
 * count, use the batched path; everything else keeps a safe sequential
 * fallback so no image is ever dropped.
 */
export function decideImageDescriptorBatch(
  images: readonly ImageDescriptorEntry[],
  capability: ImageDescriptorBatchCapability
): ImageDescriptorBatchDecision {
  if (!capability.supportsBatch) {
    return { mode: 'sequential', reason: 'harness_does_not_batch' }
  }
  if (images.length > capability.maxImages) {
    return { mode: 'sequential', reason: 'too_many_images' }
  }
  return { mode: 'batch' }
}

/**
 * One structured vision call that describes all supplied images at once. The
 * second argument is the stable call id for the whole batch so the executing
 * session can attribute the single vision call to its parent turn.
 */
export type ImageDescriptorBatchCall = (
  images: ResolvedImageEntry[],
  featureCallId: string
) => Promise<unknown>

/** One vision call for a single image, used by the sequential fallback. */
export type ImageDescriptorSingleCall = (
  image: ResolvedImageEntry
) => Promise<ImageDescriptorResult>

export interface ImageDescriptorBatchRun {
  mode: ImageDescriptorBatchMode
  /**
   * One stable call id for the whole batch so the ledger attributes a single
   * batched call to its parent turn instead of one event per image.
   */
  featureCallId: string
  results: ImageDescriptorResult[]
}

/**
 * Run a multi-image request. Compatible requests make exactly one structured
 * vision call and return an ordered result per input image; incompatible or
 * oversized requests fall back to one call per image. The result always has one
 * `featureCallId` so the invoking session can attribute the whole run once.
 */
export async function runImageDescriptorBatch(
  images: ResolvedImageEntry[],
  capability: ImageDescriptorBatchCapability,
  batchCall: ImageDescriptorBatchCall,
  singleCall: ImageDescriptorSingleCall
): Promise<ImageDescriptorBatchRun> {
  const decision = decideImageDescriptorBatch(images, capability)
  const featureCallId = generateId()
  if (decision.mode === 'sequential') {
    const results: ImageDescriptorResult[] = []
    for (const image of images) {
      results.push(await singleCall(image))
    }
    return { mode: 'sequential', featureCallId, results }
  }
  const rawOutput = await batchCall(images, featureCallId)
  return {
    mode: 'batch',
    featureCallId,
    results: assembleBatchedImageDescriptorResults(images, rawOutput)
  }
}

/**
 * Map a single structured vision response into ordered per-image results, one
 * per input entry in input order. Outputs are matched to inputs strictly by id,
 * so a missing, partial, or malformed entry can never be mislabeled as another
 * image: anything the model did not describe reports an error on that image's
 * own entry instead.
 */
export function assembleBatchedImageDescriptorResults(
  images: ResolvedImageEntry[],
  rawOutput: unknown
): ImageDescriptorResult[] {
  const outputs = new Map<string, { description: string; error?: string }>()
  for (const item of collectRawBatchedOutputs(rawOutput)) {
    const id = item['id']
    if (typeof id !== 'string' || id.length === 0) continue
    const description = typeof item['description'] === 'string' ? item['description'].trim() : ''
    const error = typeof item['error'] === 'string' ? item['error'].trim() : undefined
    const existing = outputs.get(id)
    if (!existing || (existing.description === '' && description !== '')) {
      outputs.set(id, {
        description: description || existing?.description || '',
        ...(error !== undefined ? { error } : {})
      })
    }
  }
  return images.map((image) => {
    const output = outputs.get(image.id)
    if (!output || (output.description === '' && output.error === undefined)) {
      return {
        id: image.id,
        source: image.source,
        type: image.type,
        description: '',
        error: 'The vision model returned no description for this image.'
      }
    }
    const result: ImageDescriptorResult = {
      id: image.id,
      source: image.source,
      type: image.type,
      description: output.description
    }
    if (output.error !== undefined) result.error = output.error
    return result
  })
}

function collectRawBatchedOutputs(rawOutput: unknown): Array<Record<string, unknown>> {
  const candidate =
    isRecord(rawOutput) && Array.isArray(rawOutput['results']) ? rawOutput['results'] : rawOutput
  if (!Array.isArray(candidate)) return []
  return candidate.filter(isRecord)
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** Baseline inactivity window for image upload plus the first provider response. */
const BASE_INACTIVITY_TIMEOUT_MS = 180_000
/** Conservative upload floor used to scale the window for embedded image payloads. */
const UPLOAD_BYTES_PER_SECOND = 64 * 1024
/** Prevent a malformed/oversized payload from creating an unbounded timer. */
const MAX_INACTIVITY_TIMEOUT_MS = 30 * 60_000

/**
 * Scale the no-activity window to the embedded upload size. Each retry doubles
 * the whole window; streamed provider activity resets it in the chat engine.
 */
export function imageDescriptorInactivityTimeoutMs(
  attachment: PromptAttachment,
  attempt: number
): number {
  const embeddedBytes = attachment.url.startsWith('data:') ? attachment.url.length : 0
  const uploadMs = Math.ceil((embeddedBytes / UPLOAD_BYTES_PER_SECOND) * 1_000)
  const attemptMultiplier = 2 ** attempt
  return Math.min(
    MAX_INACTIVITY_TIMEOUT_MS,
    (BASE_INACTIVITY_TIMEOUT_MS + uploadMs) * attemptMultiplier
  )
}

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

/**
 * Resolve a local `path` source to the exact readable file the vision session
 * will open. Pasted and dropped images are copied into the project's temporary
 * attachment directory before dispatch, so the path is stable for the life of
 * the conversation; passing that path (instead of embedding the bytes) keeps
 * the vision prompt free of base64 inflation. Remote `http(s)` and already
 * embedded `data:` sources are returned unchanged (the harness fetches or
 * decodes those itself). An unresolvable local file throws a clear error
 * instead of handing the vision session a dead file URL.
 */
export async function resolveVisionAttachment(
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
  // Re-derive the URL from the resolved path so a whitespace-normalized echo
  // of the source still reaches the file that actually exists.
  return {
    mime: entry.attachment.mime,
    url: pathToFileUrl(path),
    filename: entry.attachment.filename ?? basename(path)
  }
}
