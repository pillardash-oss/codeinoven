import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../../system/logger'

/**
 * A character limit, deliberately not presented as a measured token count.
 *
 * Applied to each text part on its own, and the bridges render one part per tool
 * call the caller made, so this is a ceiling on a single result rather than on a
 * whole round trip. A batch that activates two capabilities hands back two
 * catalogs sized independently of each other.
 */
export const GATEWAY_TEXT_CHARACTER_LIMIT = 15_000

export interface GatewayOutputMeasurement {
  originalTextCharacters: number
  returnedTextCharacters: number
  omittedTextCharacters: number
  savedTextParts: number
  structuredPayloadRetained: boolean
}

/**
 * How one result is bounded, when the caller has its own page in mind.
 *
 * The limit is the caller's `charSize` for this call, so raising it enlarges the
 * answer instead of colliding with a fixed ceiling. `observe` receives the
 * measurement the audit records.
 */
export interface GatewayOutputBudget {
  limit?: number
  observe?: (measurement: GatewayOutputMeasurement) => void
}

/**
 * One oversized part, delivered whole as the sections it is written in.
 *
 * A capability's contract is a markdown document, and 15,000 characters is not
 * enough for one that states everything a discipline needs: the design playbook is
 * longer than that on its own. Cutting it and moving the rest to a file is the
 * worst answer, because the model then works from a fraction of the contract it
 * just asked for. A section is a whole idea, so packing sections into as many
 * parts as they need keeps every rule in front of the model and still bounds each
 * part. Text without sections is left to the file-backed shortening below.
 */
export function sectionParts(text: string, limit = GATEWAY_TEXT_CHARACTER_LIMIT): string[] | null {
  const sections = text.split(/\n(?=## )/)
  if (sections.length < 2) return null
  const parts: string[] = []
  let current = ''
  for (const section of sections) {
    // A single section past the limit cannot be split by meaning here, so the
    // caller's file-backed shortening stays the one path that cuts text.
    if (section.length > limit) return null
    const next = current === '' ? section : `${current}\n${section}`
    if (next.length > limit) {
      parts.push(current)
      current = section
      continue
    }
    current = next
  }
  if (current !== '') parts.push(current)
  return parts.length > 1 ? parts : null
}

/**
 * Bound model-facing text while preserving the complete structured value for
 * code-mode filtering. Images and other content parts retain their transport.
 * Oversized text remains available through a project-local file, so truncation
 * never silently discards evidence or forces a tool operation to run again.
 *
 * The limit bounds one part, never the sum of them: a part is one result, and
 * `gatewayStructuredResult` renders a payload that carried several results as
 * one part each, so a verbose call can no longer shorten the other calls it
 * travelled with.
 */
export async function budgetGatewayOutput(
  result: unknown,
  projectPath: string,
  budget: GatewayOutputBudget = {}
): Promise<unknown> {
  const limit = budget.limit ?? GATEWAY_TEXT_CHARACTER_LIMIT
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
    if (entry['type'] !== 'text' || typeof text !== 'string' || text.length <= limit) {
      content.push(part)
      if (entry['type'] === 'text' && typeof text === 'string')
        returnedTextCharacters += text.length
      continue
    }
    const sections = sectionParts(text, limit)
    if (sections) {
      for (const section of sections) {
        content.push({ ...entry, text: section })
        returnedTextCharacters += section.length
      }
      changed = true
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
    const keep = Math.max(0, Math.floor((limit - marker.length) / 2))
    const preview = text.slice(0, keep) + marker + text.slice(-keep)
    content.push({ ...entry, text: preview })
    returnedTextCharacters += preview.length
    omittedTextCharacters += text.length - keep * 2
    savedTextParts += 1
    changed = true
  }
  budget.observe?.({
    originalTextCharacters,
    returnedTextCharacters,
    omittedTextCharacters,
    savedTextParts,
    structuredPayloadRetained: 'structuredContent' in record
  })
  return changed ? { ...record, content } : result
}
