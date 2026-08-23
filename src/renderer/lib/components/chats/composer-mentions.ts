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

/**
 * Trim a composer draft while preserving the single separator inserted after
 * a terminal project mention. This keeps sent text consistent with the draft
 * without retaining unrelated trailing whitespace.
 */
export function normalizeComposerMessage(
  text: string,
  projectReferences: readonly Pick<PromptProjectReference, 'path'>[]
): string {
  const trimmed = text.trim()
  if (!trimmed || !/\s$/u.test(text)) return trimmed

  const endsWithProjectMention = projectReferences.some((reference) =>
    trimmed.endsWith(`@${reference.path}`)
  )
  return endsWithProjectMention ? `${trimmed} ` : trimmed
}
