import type { BrainstormDocument } from '../types'

export function exportBrainstormMarkdown(document: Pick<BrainstormDocument, 'content'>): string {
  return [
    `# ${document.content.title}`,
    '',
    '## Session Snapshot',
    '',
    document.content.summary,
    '',
    ...document.content.sections.flatMap((section) => [
      `## ${section.title}`,
      '',
      section.markdown,
      ''
    ]),
    ...(document.content.prototypes?.length
      ? [
          '## Prototypes',
          '',
          ...document.content.prototypes.flatMap((prototype) => [
            `### ${prototype.id}: ${prototype.title}`,
            '',
            `- Fidelity: ${prototype.fidelity === 'lofi' ? 'LoFi' : 'HiFi'}`,
            ...(prototype.parentPrototypeId ? [`- Based on: ${prototype.parentPrototypeId}`] : []),
            `- Preview: ${prototype.previewPath}`,
            ''
          ])
        ]
      : [])
  ].join('\n')
}
