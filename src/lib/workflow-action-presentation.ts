import type { UserMessagePresentation } from './types'

export const WORKFLOW_ACTION_COMMENT_DISPLAY_LIMIT = 2_000

/** Keep workflow history compact without changing the full comment sent to the agent. */
export function workflowActionPresentation(action: string, comment = ''): UserMessagePresentation {
  const trimmedComment = comment.trim()
  if (!trimmedComment) return { action }
  if (trimmedComment.length <= WORKFLOW_ACTION_COMMENT_DISPLAY_LIMIT) {
    return { action, body: trimmedComment }
  }

  return {
    action,
    body: `${trimmedComment.slice(0, WORKFLOW_ACTION_COMMENT_DISPLAY_LIMIT - 1).trimEnd()}…`
  }
}
