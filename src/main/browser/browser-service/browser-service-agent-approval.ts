import { type BrowserActionReview } from './browser-action-policy'

/**
 * What an agent may do to the page a person is reading.
 *
 * A browser tab's assistant conversation answers about the page on screen, so its
 * browser capability is attached to that tab. Reading operations observe it;
 * mutations pass through action-aware Auto Review. The two operation sets and the
 * approval shapes are declared here because the service, the chat engine and the
 * permission card all have to agree on them.
 */

/**
 * The browser operations a page belonging to the user answers.
 *
 * A browser tab's assistant conversation answers about the page on screen, so its
 * browser capability is attached to that tab. Reading operations observe it;
 * mutations pass through action-aware Auto Review. File upload uses a native
 * file chooser or exact-file confirmation, while Full Access may name files.
 */
export const ATTACHED_PAGE_READ_OPERATIONS = new Set(['snapshot', 'screenshot', 'console', 'wait'])

export const ATTACHED_PAGE_MUTATION_OPERATIONS = new Set([
  'click',
  'type',
  'press',
  'select',
  'check',
  'mouse',
  'drag',
  'scroll',
  'navigate',
  'reload',
  'viewport',
  'upload',
  'evaluate'
])

/** Approval request for an agent mutation on the page the user is viewing. */
export interface BrowserAgentActionApproval {
  projectId: string
  threadId: string
  sessionId?: string
  operation: string
  /** Human-readable description shown on the permission card. */
  action: string
  origin: string
  pageUrl: string
  review: BrowserActionReview
}

/** Outcome of a permission-card approval. An alternative carries the user's correction. */
export interface BrowserAgentActionDecision {
  approved: boolean
  alternative?: string
}

/** Resolves an attached-page mutation through the permission card. */
export type BrowserAgentActionApprover = (
  request: BrowserAgentActionApproval
) => Promise<BrowserAgentActionDecision | boolean>
