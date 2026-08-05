import type { AssignmentTask, ProjectFileEntry } from '$shared/types'

export type ComposerMentionEntry =
  { type: 'project'; entry: ProjectFileEntry } | { type: 'task'; entry: AssignmentTask }

export function composerMentionKey(mention: ComposerMentionEntry): string {
  return mention.type === 'project' ? `project:${mention.entry.path}` : `task:${mention.entry.id}`
}
