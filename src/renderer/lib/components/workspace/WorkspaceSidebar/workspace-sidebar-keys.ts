/**
 * The settle key of one project's folder list.
 *
 * The sidebar's row settle orders four lists (the timeline, the chats and every
 * folder), and the project's own key is namespaced so a project id can never
 * collide with one of the fixed keys.
 */
export function projectOrderKey(projectId: string): string {
  return `project:${projectId}`
}
