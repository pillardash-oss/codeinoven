import type { MemoryCategory, MemoryPriority, MemoryScope } from '../types'

export interface ConfirmationRequest {
  id: string
  type: 'add' | 'edit' | 'remove'
  label: string
  content: string
  category: MemoryCategory
  priority: MemoryPriority
  scope: MemoryScope
  source: 'manual' | 'auto-detected'
  createdAt: number
}

export interface ConfirmationResponse {
  requestId: string
  approved: boolean
  modifiedContent?: string
  modifiedPriority?: MemoryPriority
}

/**
 * Format a confirmation request for display to the user.
 * Returns a string that can be sent as a message.
 */
export function formatConfirmationRequest(request: ConfirmationRequest): string {
  const typeLabel = {
    add: 'Add to Memory',
    edit: 'Update Memory',
    remove: 'Remove from Memory'
  }[request.type]

  const lines: string[] = [
    `**${typeLabel}:**`,
    '',
    `**Label:** ${request.label}`,
    `**Content:** ${request.content}`,
    `**Category:** ${request.category}`,
    `**Priority:** ${request.priority}`,
    `**Scope:** ${request.scope}`,
    `**Source:** ${request.source}`,
    '',
    'Reply with "yes" to confirm, "no" to cancel, or provide modified content.'
  ]

  return lines.join('\n')
}

/**
 * Parse a user's response to a confirmation request.
 */
export function parseConfirmationResponse(
  response: string,
  requestId: string
): ConfirmationResponse {
  const trimmed = response.trim().toLowerCase()

  if (trimmed === 'yes' || trimmed === 'y' || trimmed === 'confirm') {
    return { requestId, approved: true }
  }

  if (trimmed === 'no' || trimmed === 'n' || trimmed === 'cancel') {
    return { requestId, approved: false }
  }

  // Treat as modified content
  return {
    requestId,
    approved: true,
    modifiedContent: response.trim()
  }
}

/** Generate a unique confirmation request ID. */
export function generateConfirmationId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
