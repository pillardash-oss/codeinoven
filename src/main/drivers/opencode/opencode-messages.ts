import type { AgentPart } from '../../../lib/types'
import { isOpenCodeAbortError } from './opencode-issues'
import { isOpenCodeCompactionContinuePart, mapOpenCodePart } from './opencode-parts'
import type { OpenCodeAgentMessage } from './opencode-parts'
import { mapOpenCodeUsage } from './opencode-usage'
import { numberValue, recordValue, stringValue } from './opencode-values'

/** Map one OpenCode wire-format message entry into the shared message shape. */
export function mapOpenCodeMessage(
  info: Record<string, unknown>,
  parts: Array<Record<string, unknown>>
): OpenCodeAgentMessage | null {
  const role = info['role']
  if (role !== 'user' && role !== 'assistant') return null

  const time = info['time'] as { created?: number; completed?: number } | undefined
  const error = recordValue(info['error'])
  const errorData = recordValue(error?.['data'])
  const userModel = info['model'] as Record<string, unknown> | undefined
  const compactionSummary = info['summary'] === true || info['mode'] === 'compaction'
  // Keep aborted compaction summaries out of the mirror's error state too:
  // they are transient, and the conversation is intact.
  const errorMessage =
    compactionSummary && isOpenCodeAbortError(info['error'])
      ? undefined
      : (stringValue(errorData?.['message']) ?? stringValue(error?.['message']))
  const { aggregateTokens, normalizedUsage } = mapOpenCodeUsage(info['tokens'])
  const hiddenTransportParts = parts
    .filter(isOpenCodeCompactionContinuePart)
    .map((part, index): AgentPart => ({
      type: 'text',
      id: stringValue(part['id']) ?? `${String(info['id'] ?? 'message')}-transport-${index}`,
      messageID: stringValue(part['messageID']) ?? String(info['id'] ?? ''),
      text: stringValue(part['text']) ?? ''
    }))
  const mappedParts = parts
    .map((part) => mapOpenCodePart(part))
    .filter((part): part is AgentPart => part !== null)
    .map((part): AgentPart =>
      compactionSummary && part.type === 'text'
        ? {
            type: 'compaction-summary',
            id: part.id,
            messageID: part.messageID,
            text: part.text
          }
        : part
    )
  if (
    role === 'user' &&
    mappedParts.length === 0 &&
    parts.length > 0 &&
    hiddenTransportParts.length === 0
  ) {
    return null
  }

  return {
    id: (info['id'] as string | undefined) ?? '',
    role,
    ...(hiddenTransportParts.length > 0
      ? {
          origin: 'harness' as const,
          visibility: 'hidden' as const,
          transportParts: hiddenTransportParts,
          transportOrigin: 'harness' as const
        }
      : {}),
    parts: mappedParts,
    modelId:
      (info['modelID'] as string | undefined) ?? (userModel?.['modelID'] as string | undefined),
    providerId:
      (info['providerID'] as string | undefined) ??
      (userModel?.['providerID'] as string | undefined),
    createdAt: time?.created ?? 0,
    completedAt: time?.completed,
    cost: numberValue(info['cost']),
    ...(normalizedUsage ? { normalizedUsage } : {}),
    tokens: aggregateTokens,
    error: errorMessage,
    structuredOutput: info['structured'] ?? info['structured_output']
  }
}
