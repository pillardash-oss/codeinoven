import type { BrainstormDocument } from '../types'

export function exportBrainstormMarkdown(document: BrainstormDocument): string {
  return [
    `# ${document.content.title}`,
    '',
    '## TL;DR',
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
