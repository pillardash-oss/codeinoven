import { normalizeAgentQuestions } from '../../../lib/agent-interactions'
import type { AgentQuestion } from '../../../lib/types'
import {
  CIO_PERMISSION_MARKER,
  CIO_QUESTION_MARKER,
  CIO_SECRET_MARKER
} from '../pi-core-tools-extension'
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Parse the `cio_ask_secret` envelope. Each request becomes one secret question
 * carrying the id and environment variable the collected value is bound to; the
 * value itself never appears here, only the request metadata.
 */
export function secretMarkerPayload(record: Record<string, unknown>): AgentQuestion[] | null {
  const title = stringValue(record['title'])
  if (!title?.startsWith(CIO_SECRET_MARKER)) return null
  try {
    const payload = JSON.parse(title.slice(CIO_SECRET_MARKER.length)) as { secrets?: unknown }
    if (!Array.isArray(payload.secrets)) return null
    const raw: Record<string, unknown>[] = []
    for (const entry of payload.secrets) {
      const secret = recordValue(entry)
      if (!secret) continue
      const id = stringValue(secret['id'])
      const label = stringValue(secret['title'])
      if (!id || !label) continue
      const description = stringValue(secret['description'])
      const environmentVariable = stringValue(secret['environmentVariable'])
      const utilityId = stringValue(secret['utilityId'])
      raw.push({
        question: label,
        header: label,
        ...(description ? { description } : {}),
        secretRequest: true,
        secretId: id,
        ...(environmentVariable ? { secretEnvironmentVariable: environmentVariable } : {}),
        ...(utilityId ? { secretUtilityId: utilityId } : {})
      })
    }
    if (raw.length === 0) return null
    return normalizeAgentQuestions({ questions: raw })
  } catch {
    return null
  }
}

/** Parse the core-tools permission gate's marker payload from a confirm
 *  dialog, or null when the dialog is an ordinary confirmation. */
export function permissionMarkerPayload(
  record: Record<string, unknown>
): { permission: string; patterns: string[]; tool?: string; command?: string } | null {
  if (stringValue(record['method']) !== 'confirm') return null
  const message = stringValue(record['message'])
  if (!message?.startsWith(CIO_PERMISSION_MARKER)) return null
  try {
    const payload = JSON.parse(message.slice(CIO_PERMISSION_MARKER.length)) as {
      permission?: unknown
      patterns?: unknown
      tool?: unknown
      command?: unknown
    }
    const permission = typeof payload.permission === 'string' ? payload.permission : ''
    if (!permission) return null
    const patterns = Array.isArray(payload.patterns)
      ? payload.patterns.filter((pattern): pattern is string => typeof pattern === 'string')
      : []
    return {
      permission,
      patterns,
      ...(typeof payload.tool === 'string' ? { tool: payload.tool } : {}),
      ...(typeof payload.command === 'string' ? { command: payload.command } : {})
    }
  } catch {
    return null
  }
}
