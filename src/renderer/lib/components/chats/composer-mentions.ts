import type { AssignmentTask, ProjectFileEntry } from '$shared/types'

export type ComposerMentionEntry =
  | { type: 'project'; entry: ProjectFileEntry }
  | { type: 'task'; entry: AssignmentTask }
  | {
      type: 'utility'
      entry: { id: 'cio-utility'; name: '@cio-utility'; description: string }
    }

const COMPOSER_MENTION_PATTERN = /(^|\s)@([^\s@]*)$/u

function isEscaped(source: string, index: number): boolean {
  let backslashCount = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function hasOpenDoubleQuote(source: string): boolean {
  let straightQuoteOpen = false
  let curlyQuoteOpen = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"' && !isEscaped(source, index)) straightQuoteOpen = !straightQuoteOpen
    else if (character === '“') curlyQuoteOpen = true
    else if (character === '”') curlyQuoteOpen = false
  }

  return straightQuoteOpen || curlyQuoteOpen
}

export function composerMentionQuery(textBeforeCaret: string): string | null {
  const match = COMPOSER_MENTION_PATTERN.exec(textBeforeCaret)
  if (!match || match.index === undefined) return null

  const mentionStart = match.index + (match[1]?.length ?? 0)
  const textBeforeMention = textBeforeCaret.slice(0, mentionStart)
  const currentLinePrefix = textBeforeMention.slice(textBeforeMention.lastIndexOf('\n') + 1)
  if (/^\s*>/u.test(currentLinePrefix) || hasOpenDoubleQuote(textBeforeMention)) return null

  return match[2] ?? ''
}

export function composerMentionKey(mention: ComposerMentionEntry): string {
  if (mention.type === 'project') return `project:${mention.entry.path}`
  if (mention.type === 'task') return `task:${mention.entry.id}`
  return `utility:${mention.entry.id}`
}
