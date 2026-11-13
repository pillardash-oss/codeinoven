/**
 * Stable identity of the worker card an Assignment draft run wears on its parent
 * thread.
 *
 * One card per coordinator: a later run replaces the same part instead of
 * stacking a second worker beside it, and the id is what the session panel keys
 * its tab on.
 */
export function assignmentDraftPartId(projectId: string, threadId: string): string {
  return `assignment-draft:${projectId}:${threadId}`
}
