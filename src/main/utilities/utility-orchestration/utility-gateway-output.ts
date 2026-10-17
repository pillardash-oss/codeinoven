import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../../system/logger'

/** A character limit, deliberately not presented as a measured token count. */
export const GATEWAY_TEXT_CHARACTER_LIMIT = 12_000

export interface GatewayOutputMeasurement {
  originalTextCharacters: number
  returnedTextCharacters: number
  omittedTextCharacters: number
  savedTextParts: number
  structuredPayloadRetained: boolean
}

/**
 * Bound model-facing text while preserving the complete structured value for
 * code-mode filtering. Images and other content parts retain their transport.
 * Oversized text remains available through a project-local file, so truncation
 * never silently discards evidence or forces a tool operation to run again.
 */
export async function budgetGatewayOutput(
  result: unknown,
  projectPath: string,
  observe?: (measurement: GatewayOutputMeasurement) => void
): Promise<unknown> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  if (!Array.isArray(record['content'])) return result
  let changed = false
  let originalTextCharacters = 0
  let returnedTextCharacters = 0
  let omittedTextCharacters = 0
  let savedTextParts = 0
  const content: unknown[] = []
  for (const part of record['content'] as unknown[]) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      content.push(part)
      continue
    }
    const entry = part as Record<string, unknown>
    const text = entry['text']
    if (entry['type'] === 'text' && typeof text === 'string') originalTextCharacters += text.length
    if (
      entry['type'] !== 'text' ||
      typeof text !== 'string' ||
      text.length <= GATEWAY_TEXT_CHARACTER_LIMIT
    ) {
      content.push(part)
      if (entry['type'] === 'text' && typeof text === 'string')
        returnedTextCharacters += text.length
      continue
    }
    const relativePath = `.cio/tmp/utility-output/${randomUUID()}.txt`
    try {
      await mkdir(join(projectPath, '.cio/tmp/utility-output'), { recursive: true })
      await writeFile(join(projectPath, relativePath), text, { mode: 0o600 })
    } catch (error) {
      // The operation already ran. A disk failure must not turn its success
      // into a tool failure that invites the model to repeat a mutation.
      Logger.error('Could not preserve oversized utility text:', error)
      content.push(part)
      returnedTextCharacters += text.length
      continue
    }
    const structuredNote =
      'structuredContent' in record ? ' Code mode retains the full structured result.' : ''
    const marker = `\n[Text shortened from ${text.length} characters. Complete output: ${relativePath}. Read a targeted range.${structuredNote}]\n`
    const keep = Math.max(0, Math.floor((GATEWAY_TEXT_CHARACTER_LIMIT - marker.length) / 2))
    const preview = text.slice(0, keep) + marker + text.slice(-keep)
    content.push({ ...entry, text: preview })
    returnedTextCharacters += preview.length
    omittedTextCharacters += text.length - keep * 2
    savedTextParts += 1
    changed = true
  }
  observe?.({
    originalTextCharacters,
    returnedTextCharacters,
    omittedTextCharacters,
    savedTextParts,
    structuredPayloadRetained: 'structuredContent' in record
  })
  return changed ? { ...record, content } : result
}
