/// <reference types="node" />

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PromptAttachment } from '../../lib/types'
import { toPosixPath } from '../../lib/paths'
import { CIO_SCRATCH_DIRECTORY } from '../../lib/cio-cleanup'

/** Extensions every harness's image decoder recognizes by file name. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg'
}

/** Largest image payload the app will stage for one attachment. */
const MAX_MATERIALIZED_BYTES = 16 * 1024 * 1024

/** How long a remote image may take to answer before the descriptor gives up. */
const REMOTE_FETCH_TIMEOUT_MS = 20_000

/**
 * Where an embedded or remote attachment payload is written before dispatch:
 * the conversation's own scratch directory, the same `.cio/tmp/attachments`
 * folder the composer stages pasted files in, so the file is gitignored and
 * removed with the thread rather than left in system temp.
 */
export function attachmentScratchDirectory(projectPath: string): string {
  return join(projectPath, CIO_SCRATCH_DIRECTORY, 'tmp', 'attachments')
}

/**
 * A source the app cannot turn into an image: an unmatchable URL, a page instead
 * of an image, an oversized payload, or a malformed embedded payload.
 *
 * This is a problem with the request, never with the vision model, so callers
 * report it on that image's own result instead of retrying another model or
 * interrupting the user with a model-choice card.
 */
export class ImageSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageSourceError'
  }
}

/** Whether an attachment carries its bytes inline instead of naming a file. */
export function isDataUrlAttachment(attachment: PromptAttachment): boolean {
  return attachment.url.startsWith('data:')
}

/** Whether an attachment names a resource the app has to download itself. */
export function isRemoteAttachment(attachment: PromptAttachment): boolean {
  return /^https?:\/\//iu.test(attachment.url)
}

/**
 * Resolve every attachment whose bytes are not already a local file into a real
 * file inside `directory`, and answer the same attachment pointing at it.
 *
 * Not every harness can open a data URL or fetch a URL: the OpenCode backend
 * resolves a prompt file part through `Bun.file`, which treats the whole
 * `data:...` or `http://...` string as a filesystem path and fails with ENOENT
 * before the model ever sees the image. Decoding or downloading the payload
 * once here gives every harness a plain file path and keeps megabytes of
 * base64 out of the prompt. A local attachment is returned unchanged.
 */
export async function materializeAttachment(
  attachment: PromptAttachment,
  directory: string
): Promise<PromptAttachment> {
  if (isDataUrlAttachment(attachment)) return materializeDataUrlAttachment(attachment, directory)
  if (isRemoteAttachment(attachment)) return materializeRemoteAttachment(attachment, directory)
  return attachment
}

/**
 * Write an embedded `data:` attachment into a real file inside `directory`.
 * The decoded file is named after its own bytes, so a retry of the same image
 * reuses the file it already wrote instead of staging another copy.
 */
export async function materializeDataUrlAttachment(
  attachment: PromptAttachment,
  directory: string
): Promise<PromptAttachment> {
  const comma = attachment.url.indexOf(',')
  if (comma === -1) {
    throw new ImageSourceError('Image data URL is malformed: the payload separator is missing.')
  }
  const header = attachment.url.slice(5, comma)
  const base64 = header.split(';').includes('base64')
  const declaredMime = header.split(';')[0]?.trim().toLowerCase() ?? ''
  const payload = attachment.url.slice(comma + 1)
  let bytes: Buffer
  try {
    bytes = base64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
  } catch {
    throw new ImageSourceError('Image data URL is malformed: the payload could not be decoded.')
  }
  if (bytes.byteLength === 0) {
    throw new ImageSourceError('Image data URL is empty: there is nothing to describe.')
  }
  const mime = declaredMime.startsWith('image/')
    ? declaredMime
    : (sniffImageMagic(bytes) ?? 'image/png')
  return writeStagedAttachment(bytes, mime, directory, attachment.filename)
}

/**
 * Download a remote `http(s)` attachment into a real file inside `directory`.
 *
 * A vision call is handed a URL that is a page rather than an image far more
 * often than one would hope (a dev-server route, a route the model guessed), so
 * anything that does not answer with image bytes is refused here with a message
 * that names the actual problem. Passing the URL through would only move the
 * failure into the harness, where it surfaces as a path error that says nothing
 * about the cause.
 */
export async function materializeRemoteAttachment(
  attachment: PromptAttachment,
  directory: string
): Promise<PromptAttachment> {
  let response: Response
  try {
    response = await fetch(attachment.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ImageSourceError(
      `Image source could not be downloaded: ${attachment.url} (${reason}). Pass a local image file path instead.`
    )
  }
  if (!response.ok) {
    throw new ImageSourceError(
      `Image source could not be downloaded: ${attachment.url} answered HTTP ${response.status}. Pass a local image file path instead.`
    )
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0')
  if (contentLength > MAX_MATERIALIZED_BYTES) {
    throw new ImageSourceError(
      `Image source is larger than the 16 MiB limit: ${attachment.url}. Pass the image file itself instead.`
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > MAX_MATERIALIZED_BYTES) {
    throw new ImageSourceError(
      `Image source is larger than the 16 MiB limit: ${attachment.url}. Pass the image file itself instead.`
    )
  }
  const declaredMime = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  const mime = declaredMime?.startsWith('image/') ? declaredMime : sniffImageMagic(bytes)
  if (!mime) {
    throw new ImageSourceError(
      `Image source is not an image: ${attachment.url} answered ${declaredMime || 'an unknown content type'}. Capture it as an image (for example a browser screenshot) and pass that file path.`
    )
  }
  return writeStagedAttachment(bytes, mime, directory, attachment.filename)
}

/**
 * Stage bytes as one file in `directory`. The name is derived from the content,
 * so the same payload staged twice maps to the same file and a retry does not
 * litter the scratch directory.
 */
async function writeStagedAttachment(
  bytes: Buffer,
  mime: string,
  directory: string,
  filename?: string
): Promise<PromptAttachment> {
  const extension = IMAGE_EXTENSIONS[mime] ?? '.png'
  await mkdir(directory, { recursive: true })
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const path = join(directory, `attachment-${digest}${extension}`)
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return {
    mime,
    url: fileUrlFor(path),
    filename: filename ?? basename(path)
  }
}

/** Portable file URL for a native path, matching how path attachments arrive. */
export function fileUrlFor(path: string): string {
  const normalized = toPosixPath(path)
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

/** Best-effort mime detection from image magic bytes, for unlabeled payloads. */
function sniffImageMagic(buffer: Buffer): string | undefined {
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
  return undefined
}
