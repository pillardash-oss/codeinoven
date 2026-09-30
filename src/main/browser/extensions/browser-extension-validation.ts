/**
 * Validation for the extension IPC surface.
 *
 * Every argument here arrives from a renderer, so each one is checked to the shape
 * the service can act on and nothing else: an installer that unpacked code from an
 * unvalidated path, or a jar list that could name a string the partition builder
 * later embeds, is exactly the kind of input this app refuses.
 */

import type { BrowserExtensionInstallInput } from '../../../lib/ipc/browser'
import { isExtensionId } from './browser-extension-crx'

/** A Web Store id, a store URL, or an absolute folder path. */
const MAX_INSTALL_VALUE_LENGTH = 4_096

/** A box id, matching what the partition builder accepts. */
const BOX_ID_PATTERN = /^box:[A-Za-z0-9:._-]{1,240}$/u
const MAX_BOXES_PER_PATCH = 200

export function validateExtensionId(value: unknown): string {
  if (!isExtensionId(value)) {
    throw new TypeError('Browser extension ID is invalid')
  }
  return value
}

export function validateExtensionInstallInput(value: unknown): BrowserExtensionInstallInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser extension install input is invalid')
  }
  const record = value as Record<string, unknown>
  const source = record['source']
  if (source !== 'webstore' && source !== 'folder') {
    throw new TypeError('Browser extension install source must be webstore or folder')
  }
  const rawValue = record['value']
  if (typeof rawValue !== 'string') {
    throw new TypeError('Browser extension install value is invalid')
  }
  const trimmed = rawValue.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_INSTALL_VALUE_LENGTH) {
    throw new TypeError('Browser extension install value is invalid')
  }
  const rawBoxes = record['boxes']
  return {
    source,
    value: trimmed,
    // Absent means the extension is installed and loaded nowhere. It never means
    // every jar, which is the shape this field exists to make impossible.
    boxes: rawBoxes === undefined ? [] : parseJarList(rawBoxes)
  }
}

/**
 * One jar list from the renderer: box ids, plus the empty string for the context's
 * own jar.
 *
 * Shared by install and update so a list can never be accepted on one path and
 * refused on the other, and so the box id shape is checked against what the
 * partition builder will later embed.
 */
function parseJarList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Browser extension jar list is invalid')
  }
  const jars: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      throw new TypeError('Browser extension jar list is invalid')
    }
    // The empty string is the context's own jar, which has no box id.
    if (candidate.length === 0) {
      if (!jars.includes('')) jars.push('')
      continue
    }
    if (!BOX_ID_PATTERN.test(candidate)) {
      throw new TypeError('Browser extension jar list names an invalid box')
    }
    if (!jars.includes(candidate)) jars.push(candidate)
    if (jars.length > MAX_BOXES_PER_PATCH) break
  }
  return jars
}

export function validateExtensionUpdatePatch(value: unknown): {
  enabled?: boolean
  boxes?: string[]
  pinned?: boolean
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser extension update is invalid')
  }
  const record = value as Record<string, unknown>
  const patch: { enabled?: boolean; boxes?: string[]; pinned?: boolean } = {}
  if (record['enabled'] !== undefined) {
    if (typeof record['enabled'] !== 'boolean') {
      throw new TypeError('Browser extension enabled flag is invalid')
    }
    patch.enabled = record['enabled']
  }
  if (record['boxes'] !== undefined) {
    patch.boxes = parseJarList(record['boxes'])
  }
  if (record['pinned'] !== undefined) {
    if (typeof record['pinned'] !== 'boolean') {
      throw new TypeError('Browser extension pinned flag is invalid')
    }
    patch.pinned = record['pinned']
  }
  if (patch.enabled === undefined && patch.boxes === undefined && patch.pinned === undefined) {
    throw new TypeError('Browser extension update changed nothing')
  }
  return patch
}
