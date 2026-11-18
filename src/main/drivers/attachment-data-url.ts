/// <reference types="node" />

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PromptAttachment } from '../../lib/types'
import { toPosixPath } from '../../lib/paths'
import { CIO_SCRATCH_DIRECTORY } from '../../lib/cio-cleanup'

/** Extensions every harness's image decoder recognizes by file name. */
const DATA_URL_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/tiff': '.tiff'
}

/**
 * Where an embedded attachment payload is written before dispatch: the
 * conversation's own scratch directory, the same `.cio/tmp/attachments` folder
 * the composer stages pasted files in, so the file is gitignored and removed
 * with the thread rather than left in system temp.
 */
export function attachmentScratchDirectory(projectPath: string): string {
  return join(projectPath, CIO_SCRATCH_DIRECTORY, 'tmp', 'attachments')
}

/** Whether an attachment carries its bytes inline instead of naming a file. */
export function isDataUrlAttachment(attachment: PromptAttachment): boolean {
  return attachment.url.startsWith('data:')
}

/**
 * Write an embedded `data:` attachment into a real file inside `directory` and
 * answer the same attachment pointing at that file.
 *
 * Not every harness can open a data URL: the OpenCode backend resolves a prompt
 * file part through `Bun.file`, which treats the whole `data:...` string as a
 * filesystem path and fails with ENOENT, killing the turn before the model ever
 * sees the image. Decoding the payload once here gives every harness a plain
 * file path, keeps megabytes of base64 out of the prompt, and names the file
 * after its own bytes so a retry of the same image reuses the file it already
 * wrote.
 *
 * A non-data attachment is returned unchanged.
 */
export async function materializeDataUrlAttachment(
  attachment: PromptAttachment,
  directory: string
): Promise<PromptAttachment> {
  if (!isDataUrlAttachment(attachment)) return attachment
  const comma = attachment.url.indexOf(',')
  if (comma === -1) {
    throw new Error('Image data URL is malformed: the payload separator is missing.')
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
    throw new Error('Image data URL is malformed: the payload could not be decoded.')
  }
  if (bytes.byteLength === 0) {
    throw new Error('Image data URL is empty: there is nothing to describe.')
  }
  const mime = declaredMime.startsWith('image/')
    ? declaredMime
    : (sniffImageMagic(bytes) ?? 'image/png')
  const extension = DATA_URL_EXTENSIONS[mime] ?? '.png'
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
    filename: attachment.filename ?? basename(path)
  }
}

/** Portable file URL for a native path, matching how path attachments arrive. */
function fileUrlFor(path: string): string {
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
