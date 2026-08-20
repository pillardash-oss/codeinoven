import type { AssignmentTask, ProjectFileEntry } from '$shared/types'

export type ComposerMentionEntry =
  | { type: 'project'; entry: ProjectFileEntry }
  | { type: 'task'; entry: AssignmentTask }
  | {
      type: 'utility'
      entry: { id: 'cio-utility'; name: '@cio-utility'; description: string }
    }

export function composerMentionKey(mention: ComposerMentionEntry): string {
  if (mention.type === 'project') return `project:${mention.entry.path}`
  if (mention.type === 'task') return `task:${mention.entry.id}`
  return `utility:${mention.entry.id}`
}
