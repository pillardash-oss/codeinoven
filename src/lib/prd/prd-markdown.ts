import type { PrdContent, PrdDocument } from '../types'
import { parseGeneratedPrdContent, PRD_SECTION_DEFINITIONS } from './prd-validation'

export function exportPrdMarkdown(document: Pick<PrdDocument, 'content'>): string {
  return [
    `# ${document.content.title}`,
    '',
    '## Summary',
    '',
    document.content.summary,
    '',
    ...document.content.sections.flatMap((section) => [
      `## ${section.title}`,
      '',
      section.markdown,
      ''
    ])
  ].join('\n')
}

export function parsePrdMarkdown(markdown: string): PrdContent {
  const titleMatch = /^# (.+)$/mu.exec(markdown)
  if (!titleMatch) throw new TypeError('PRD Markdown requires a title')
  const headings = [...markdown.matchAll(/^## (.+)$/gmu)]
  const contentByTitle = new Map<string, string>()
  headings.forEach((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length
    const end = headings[index + 1]?.index ?? markdown.length
    contentByTitle.set(heading[1], markdown.slice(start, end).trim())
  })
  return parseGeneratedPrdContent({
    title: titleMatch[1].trim(),
    summary: contentByTitle.get('Summary') ?? '',
    sections: PRD_SECTION_DEFINITIONS.map((definition) => ({
      ...definition,
      markdown: contentByTitle.get(definition.title) ?? ''
    }))
  })
}
