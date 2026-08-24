import type { AssignmentTask, ProjectFileEntry, PromptProjectReference } from '$shared/types'
import { isQuotedMentionPosition } from '$shared/mention-context'

export type ComposerMentionEntry =
  | { type: 'project'; entry: ProjectFileEntry }
  | { type: 'task'; entry: AssignmentTask }
  | {
      type: 'utility'
      entry: { id: 'cio-utility'; name: '@cio-utility'; description: string }
    }

const COMPOSER_MENTION_PATTERN = /(^|\s)@([^\s@]*)$/u

export function composerMentionQuery(textBeforeCaret: string): string | null {
  const match = COMPOSER_MENTION_PATTERN.exec(textBeforeCaret)
  if (!match || match.index === undefined) return null

  const mentionStart = match.index + (match[1]?.length ?? 0)
  if (isQuotedMentionPosition(textBeforeCaret, mentionStart)) return null

  return match[2] ?? ''
}

export function composerMentionKey(mention: ComposerMentionEntry): string {
  if (mention.type === 'project') return `project:${mention.entry.path}`
  if (mention.type === 'task') return `task:${mention.entry.id}`
  return `utility:${mention.entry.id}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Guarantee a single space on either side of every project-reference token
 * (`@path`) when a word is glued to it. Tagged paths are inserted mid-sentence,
 * so when a draft loses the separator the tag can ride into the next word
 * (e.g. `…investment-advisory.webpimage`). This is idempotent — an already
 * separated token is left untouched — and processes longest paths first so a
 * directory tag never swallows the tail of a longer child path.
 *
 * Exported so the thread's message rendering can space out already-sent paths.
 */
export function spaceOutProjectReferences(
  text: string,
  projectReferences: readonly Pick<PromptProjectReference, 'path'>[]
): string {
  const tokens = projectReferences
    .map((reference) => `@${reference.path}`)
    .filter((token) => token.length > 0)
    .sort((left, right) => right.length - left.length)
  if (tokens.length === 0) return text
  const pattern = new RegExp(tokens.map(escapeRegex).join('|'), 'gu')
  return text.replace(pattern, (match, offset: number) => {
    const before = offset === 0 ? '' : (text[offset - 1] ?? '')
    const after = text[offset + match.length] ?? ''
    const lead = before && !/\s/u.test(before) ? ' ' : ''
    const trail = after && !/\s/u.test(after) ? ' ' : ''
    return `${lead}${match}${trail}`
  })
}

/**
 * Trim a composer draft while preserving the single separator inserted after
 * a terminal project mention. This keeps sent text consistent with the draft
 * without retaining unrelated trailing whitespace. Project-reference tokens
 * are also spaced out from any word glued to them.
 */
export function normalizeComposerMessage(
  text: string,
  projectReferences: readonly Pick<PromptProjectReference, 'path'>[]
): string {
  const spaced = spaceOutProjectReferences(text, projectReferences)
  const trimmed = spaced.trim()
  if (!trimmed || !/\s$/u.test(spaced)) return trimmed

  const endsWithProjectMention = projectReferences.some((reference) =>
    trimmed.endsWith(`@${reference.path}`)
  )
  return endsWithProjectMention ? `${trimmed} ` : trimmed
}
