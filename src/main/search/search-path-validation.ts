import { open, readdir, stat } from 'node:fs/promises'
import {
  buildParsedIdentityForValidation,
  normalizePastedPath
} from '../../lib/speech/model-path-validation'
import type { ModelPathValidationResult } from '../../lib/speech/types'

/** What a pasted Search model path must look like, shown under the input. */
export const SEARCH_MODEL_PATH_HELP =
  'Embedding models are GGUF files: paste an absolute path to a .gguf file, or a folder that contains one.'

/**
 * Validate a pasted embedding-model path without importing anything.
 *
 * Mirrors the Sound page's paste flow: normalize the paste, stat the path so
 * the user learns about a missing file before they commit, and refuse anything
 * the embedding runtime cannot load (only GGUF today). The parsed identity is
 * returned so the modal can show what the file looks like before import.
 */
export async function validateSearchModelPath(rawPath: string): Promise<ModelPathValidationResult> {
  const { normalized, wasNormalized } = normalizePastedPath(rawPath)
  const parsed = buildParsedIdentityForValidation(normalized, 'gguf')
  const base = {
    normalizedPath: normalized,
    wasNormalized,
    runtime: 'gguf' as const,
    parsedIdentity: parsed
  }

  if (normalized.length === 0) {
    return { ...base, ok: false, code: 'empty', reason: SEARCH_MODEL_PATH_HELP }
  }
  if (normalized.length > 4_096) {
    return {
      ...base,
      ok: false,
      code: 'unsupported-format',
      reason: 'Path is too long. Paste a local file or folder path.'
    }
  }

  const lower = normalized.toLowerCase()
  const hasExtension = /\.[a-z0-9]+$/u.test(lower)
  if (hasExtension && !lower.endsWith('.gguf')) {
    return {
      ...base,
      ok: false,
      code: 'unsupported-format',
      reason: 'Embedding models must be a .gguf file or a folder containing one.',
      detectedExtension: extensionOf(lower)
    }
  }

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(normalized)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code ?? ''
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ...base,
        ok: false,
        code: 'permission-denied',
        reason: 'Permission denied at that path. Check access and try again.'
      }
    }
    return {
      ...base,
      ok: false,
      code: 'not-found',
      reason: 'No file or folder exists at that path. Check the path and try again.'
    }
  }

  if (info.isDirectory()) {
    const hasGguf = await readdir(normalized, { withFileTypes: true })
      .then((entries) =>
        entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
      )
      .catch(() => false)
    if (!hasGguf) {
      return {
        ...base,
        ok: false,
        code: 'unsupported-format',
        reason: 'The folder does not contain a .gguf embedding model.'
      }
    }
    return {
      ...base,
      ok: true,
      code: 'valid',
      reason: 'Folder found and it contains a GGUF embedding model.'
    }
  }
  if (!info.isFile()) {
    return {
      ...base,
      ok: false,
      code: 'unsupported-format',
      reason: 'The path is neither a file nor a folder.'
    }
  }
  // A single file must actually be GGUF, not merely named like one: the import
  // would refuse it afterwards otherwise.
  if (!lower.endsWith('.gguf')) {
    return {
      ...base,
      ok: false,
      code: 'unsupported-format',
      reason: 'A single model file must end in .gguf.'
    }
  }
  if (info.size === 0) {
    return { ...base, ok: false, code: 'unsupported-format', reason: 'The file is empty.' }
  }
  const magic = await readGgufMagic(normalized)
  if (magic !== 'GGUF') {
    return {
      ...base,
      ok: false,
      code: 'unsupported-format',
      reason: 'The selected file is not a GGUF model.',
      detectedExtension: '.gguf'
    }
  }
  return {
    ...base,
    ok: true,
    code: 'valid',
    reason: 'GGUF embedding model found and readable.',
    detectedExtension: '.gguf'
  }
}

/** The four magic bytes at the head of a file, or null when it is too short. */
async function readGgufMagic(path: string): Promise<string | null> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buffer, 0, 4, 0)
    return bytesRead === 4 ? buffer.toString('latin1') : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** The file extension of a lowercased path, when it has one. */
function extensionOf(lower: string): string | undefined {
  const match = /\.[a-z0-9]+$/u.exec(lower)
  return match?.[0]
}
