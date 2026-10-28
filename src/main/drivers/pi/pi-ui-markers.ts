import { normalizeAgentQuestions } from '../../../lib/agent-interactions'
import type { AgentQuestion } from '../../../lib/types'
import { CIO_PERMISSION_MARKER, CIO_QUESTION_MARKER } from '../pi-core-tools-extension'
import { stringValue } from './pi-values'

/** Parse the core-tools extension's canonical question envelope. */
export function questionMarkerPayload(record: Record<string, unknown>): AgentQuestion[] | null {
  const title = stringValue(record['title'])
  if (!title?.startsWith(CIO_QUESTION_MARKER)) return null
  try {
    const payload = JSON.parse(title.slice(CIO_QUESTION_MARKER.length)) as {
      questions?: unknown
    }
    if (!Array.isArray(payload.questions)) return null
    return normalizeAgentQuestions({ questions: payload.questions })
  } catch {
    return null
  }
}

/** Parse the core-tools permission gate's marker payload from a confirm
 *  dialog, or null when the dialog is an ordinary confirmation. */
export function permissionMarkerPayload(record: Record<string, unknown>): {
  permission: string
  patterns: string[]
  tool?: string
  command?: string
  surface?: string
  review?: string
  matchedPatterns?: string[]
  justification?: string
  reason?: string
} | null {
  const method = stringValue(record['method'])
  // The gate asks through an input dialog so the user's written alternative
  // comes back as text; an older extension still asks with a confirm dialog and
  // carries the marker in its message.
  const statement =
    method === 'input' ? stringValue(record['title']) : stringValue(record['message'])
  if (method !== 'input' && method !== 'confirm') return null
  if (!statement?.startsWith(CIO_PERMISSION_MARKER)) return null
  try {
    const payload = JSON.parse(statement.slice(CIO_PERMISSION_MARKER.length)) as {
      permission?: unknown
      patterns?: unknown
      tool?: unknown
      command?: unknown
      surface?: unknown
      review?: unknown
      matchedPatterns?: unknown
      justification?: unknown
      reason?: unknown
    }
    const permission = typeof payload.permission === 'string' ? payload.permission : ''
    if (!permission) return null
    const patterns = Array.isArray(payload.patterns)
      ? payload.patterns.filter((pattern): pattern is string => typeof pattern === 'string')
      : []
    const matchedPatterns = Array.isArray(payload.matchedPatterns)
      ? payload.matchedPatterns
          .filter(
            (pattern): pattern is string =>
              typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 256
          )
          .slice(0, 16)
      : []
    return {
      permission,
      patterns,
      ...(typeof payload.tool === 'string' ? { tool: payload.tool } : {}),
      ...(typeof payload.command === 'string' ? { command: payload.command } : {}),
      ...(typeof payload.review === 'string' ? { review: payload.review.slice(0, 12100) } : {}),
      ...(typeof payload.surface === 'string' ? { surface: payload.surface } : {}),
      ...(matchedPatterns.length > 0 ? { matchedPatterns } : {}),
      ...(typeof payload.justification === 'string' && payload.justification.trim()
        ? { justification: payload.justification.trim().slice(0, 1200) }
        : {}),
      ...(typeof payload.reason === 'string' && payload.reason.trim()
        ? { reason: payload.reason.trim().slice(0, 600) }
        : {})
    }
  } catch {
    return null
  }
}
