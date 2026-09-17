import { exportEngineeringSpecMarkdown } from '$shared/spec/spec-markdown'
import type { EngineeringSpec, SpecSectionId } from '$shared/types'

/** Markdown heading text used by the exported document for each section. */
export const markdownSectionHeadings: Record<SpecSectionId, string> = {
  problem: 'Problem',
  resolution: 'Resolution',
  success_criteria: 'Success Criteria',
  test_strategy: 'Test Strategy',
  documentation: 'Documentation',
  additional_info: 'Additional Info',
  commit_pattern: 'Commit Pattern',
  constraints_risks: 'Constraints & Risks'
}

export function occurrenceIndexes(source: string, quote: string): number[] {
  if (!quote) return []
  const indexes: number[] = []
  let offset = 0
  while (offset <= source.length - quote.length) {
    const index = source.indexOf(quote, offset)
    if (index < 0) break
    indexes.push(index)
    offset = index + Math.max(quote.length, 1)
  }
  return indexes
}

/** Which occurrence of `quote` the DOM range points at within its section. */
export function selectionOccurrence(
  sectionElement: HTMLElement,
  range: Range,
  quote: string
): number {
  const prefix = document.createRange()
  prefix.selectNodeContents(sectionElement)
  try {
    prefix.setEnd(range.startContainer, range.startOffset)
  } catch {
    return 0
  }
  return occurrenceIndexes(prefix.toString(), quote).length
}

/**
 * Map a quoted passage back to the line span it occupies in the exported
 * Markdown of `draft`, so an annotation anchor survives re-rendering.
 */
export function markdownLineForQuote(
  draft: EngineeringSpec,
  quote: string,
  sectionId: SpecSectionId,
  occurrence = 0
): { startLine: number; endLine: number } {
  const markdown = exportEngineeringSpecMarkdown(draft)
  const heading = `## ${markdownSectionHeadings[sectionId]}`
  const sectionStart = markdown.indexOf(heading)
  if (sectionStart < 0) return { startLine: 1, endLine: 1 }
  const nextHeading = markdown.indexOf('\n## ', sectionStart + heading.length)
  const sectionEnd = nextHeading < 0 ? markdown.length : nextHeading
  const sectionMarkdown = markdown.slice(sectionStart, sectionEnd)
  const escapedQuote = JSON.stringify(quote).slice(1, -1)
  const variants = [...new Set([quote, escapedQuote])]

  for (const variant of variants) {
    const matches = occurrenceIndexes(sectionMarkdown, variant)
    const match = matches[occurrence]
    if (match === undefined) continue
    const absoluteIndex = sectionStart + match
    const startLine = markdown.slice(0, absoluteIndex).split('\n').length
    return {
      startLine,
      endLine: startLine + variant.split('\n').length - 1
    }
  }

  const sectionLine = markdown.slice(0, sectionStart).split('\n').length
  return { startLine: sectionLine, endLine: sectionLine }
}
