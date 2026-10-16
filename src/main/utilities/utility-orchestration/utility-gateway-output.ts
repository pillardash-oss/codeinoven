import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../../system/logger'

/** A character limit, deliberately not presented as a measured token count. */
export const GATEWAY_TEXT_CHARACTER_LIMIT = 12_000

/**
 * Bound model-facing text while preserving the complete structured value for
 * code-mode filtering. Images and other content parts retain their transport.
 * Oversized text remains available through a project-local file, so truncation
 * never silently discards evidence or forces a tool operation to run again.
 */
export async function budgetGatewayOutput(result: unknown, projectPath: string): Promise<unknown> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  if (!Array.isArray(record['content'])) return result
  let changed = false
  const content: unknown[] = []
  for (const part of record['content'] as unknown[]) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      content.push(part)
      continue
    }
    const entry = part as Record<string, unknown>
    const text = entry['text']
    if (
      entry['type'] !== 'text' ||
      typeof text !== 'string' ||
      text.length <= GATEWAY_TEXT_CHARACTER_LIMIT
    ) {
      content.push(part)
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
      continue
    }
    const structuredNote =
      'structuredContent' in record ? ' Code mode retains the full structured result.' : ''
    const marker = `\n[Text shortened from ${text.length} characters. Complete output: ${relativePath}. Read a targeted range.${structuredNote}]\n`
    const keep = Math.max(0, Math.floor((GATEWAY_TEXT_CHARACTER_LIMIT - marker.length) / 2))
    content.push({ ...entry, text: text.slice(0, keep) + marker + text.slice(-keep) })
    changed = true
  }
  return changed ? { ...record, content } : result
}
