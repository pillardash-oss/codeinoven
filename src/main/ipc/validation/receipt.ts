import { validateBoolean, validateEntityId } from './primitives'

/**
 * Validation for a run receipt request.
 *
 * The receipt reads a checkout the user's own thread is bound to, so every id
 * crosses the boundary as an entity id and the refresh flag as a real boolean:
 * an unparsed "false" string would otherwise force a Git read on every render.
 */
export interface ValidatedReceiptRequest {
  projectId: string
  threadId: string
  scopeBucketId?: string
  refresh: boolean
}

export function validateReceiptRequest(
  projectId: unknown,
  threadId: unknown,
  scopeBucketId?: unknown,
  refresh?: unknown
): ValidatedReceiptRequest {
  return {
    projectId: validateEntityId(projectId, 'Project ID'),
    threadId: validateEntityId(threadId, 'Thread ID'),
    ...(scopeBucketId === undefined
      ? {}
      : { scopeBucketId: validateEntityId(scopeBucketId, 'Scope bucket ID') }),
    refresh: refresh === undefined ? false : validateBoolean(refresh, 'Refresh')
  }
}
