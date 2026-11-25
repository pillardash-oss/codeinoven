/**
 * Bound what a locally executed call hands a model.
 *
 * An MCP tool running on this Oven can return any amount of text, and a
 * `/docs-lookup` can carry a whole manual, so a local answer needs the ceiling
 * the app's gateway already applies (`GATEWAY_TEXT_CHARACTER_LIMIT` in
 * `utility-orchestration/utility-gateway-output`) rather than handing an
 * unbounded payload straight into a transcript.
 *
 * One deliberate difference from the app: the app spills the complete text into
 * a project-local file and points the model at it. The Oven has no checkout it
 * may write into — the turn's project path is the user's own working tree, and a
 * remote machine has no `.cio/tmp` the app could collect — so the oversized part
 * is shortened in place and says so, keeping the head and the tail. That still
 * leaves the whole value in `structuredContent`, which is what code mode reads.
 */
import type { OvenUtilityJson } from '../../../../lib/oven-utility-host'
import { GATEWAY_TEXT_CHARACTER_LIMIT } from '../../../utilities/utility-orchestration/utility-gateway-output'
import { isRecord } from './oven-utility-local-context'

/** Shorten every oversized text part of one gateway-shaped answer. */
export function boundOvenUtilityOutput(value: OvenUtilityJson): OvenUtilityJson {
  if (!isRecord(value)) return value
  const content = value['content']
  if (!Array.isArray(content)) return value
  const structuredRetained = value['structuredContent'] !== undefined
  let changed = false
  const bounded = content.map((part) => {
    if (!isRecord(part) || part['type'] !== 'text') return part
    const text = part['text']
    if (typeof text !== 'string' || text.length <= GATEWAY_TEXT_CHARACTER_LIMIT) return part
    changed = true
    return { ...part, text: shortenOvenUtilityText(text, structuredRetained) }
  })
  return changed ? { ...value, content: bounded } : value
}

/**
 * One text, cut to the limit with a marker in the middle.
 *
 * The marker names the original length and says where the text went (nowhere:
 * this is the Oven's own copy), so a model reading half a payload does not
 * mistake the shortening for the tool's real answer.
 */
export function shortenOvenUtilityText(text: string, structuredRetained: boolean): string {
  const structuredNote = structuredRetained ? ' Code mode retains the full structured result.' : ''
  const marker = `\n[Text shortened from ${text.length} characters: this answer was truncated on the Oven, which keeps no file with the complete text.${structuredNote}]\n`
  const keep = Math.floor((GATEWAY_TEXT_CHARACTER_LIMIT - marker.length) / 2)
  // `slice(-0)` is the whole string, so an unusable budget keeps only the marker
  // rather than silently returning everything it was asked to bound.
  if (keep <= 0) return marker
  return text.slice(0, keep) + marker + text.slice(-keep)
}
