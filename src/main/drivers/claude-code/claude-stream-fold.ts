import { normalizeAgentQuestions, permissionPatterns } from '../../../lib/agent-interactions'
import type { AgentPart, SessionAgentEvent } from '../../../lib/types'
import type { CliLineParseContext, CliLineParseResult } from '../persistent-cli-driver'
import { claudeApiRetryKind, claudeResultIssue, claudeSessionLimitIssue } from './claude-errors'
import {
  CLAUDE_ASYNC_AGENT_LAUNCH_MARKER,
  activeClaudeSubagentParts,
  findSubagentPart,
  findToolPart,
  latestAssistant,
  mergeAssistantRecord,
  messageFromAssistant,
  partFromBlock,
  toolPart
} from './claude-parts'
import {
  aggregateModelUsage,
  latestClaudeRateLimits,
  latestIterationContextUsed,
  mapClaudeNormalizedUsage,
  preserveNormalizedReasoning,
  preserveReasoningUsage,
  rateLimitWindows,
  tokenUsage
} from './claude-usage'
import {
  epochMilliseconds,
  number,
  numberProperty,
  record,
  serializeContent,
  string
} from './claude-values'

/** Folds Claude Code stream-json records into session messages and events. */

/** Map one documented Claude Code stream-json record to CodeInOven's stable shapes. */
export function mapClaudeCodeRecord(
  value: unknown,
  context: CliLineParseContext
): CliLineParseResult | null {
  const entry = record(value)
  if (!entry) return null
  const type = string(entry['type'])
  const nativeSessionId = string(entry['session_id'])
  if (type === 'system' && entry['subtype'] === 'init') return { nativeSessionId }

  if (type === 'system' && entry['subtype'] === 'compact_boundary') {
    const metadata = record(entry['compact_metadata']) ?? record(entry['compactMetadata'])
    const trigger = string(metadata?.['trigger'])
    const messageId =
      string(entry['uuid']) ??
      `claude-compaction-${context.sessionId}-${number(metadata?.['pre_tokens']) ?? Date.now()}`
    const part = {
      type: 'compaction' as const,
      id: `${messageId}:compaction`,
      messageID: messageId,
      auto: trigger !== 'manual',
      overflow: trigger === 'auto'
    }
    return {
      nativeSessionId,
      messages: [
        {
          id: messageId,
          role: 'assistant',
          origin: 'compaction',
          visibility: 'working_trace',
          parts: [part],
          createdAt: Date.now(),
          completedAt: Date.now()
        }
      ],
      events: [
        { type: 'message.part.updated', sessionId: context.sessionId, part },
        {
          type: 'message.completed',
          sessionId: context.sessionId,
          messageId,
          compaction: true
        }
      ]
    }
  }

  if (type === 'control_request') {
    const request = record(entry['request'])
    const requestId = string(entry['request_id'])
    if (request?.['subtype'] !== 'can_use_tool' || !requestId) {
      return nativeSessionId ? { nativeSessionId } : null
    }
    const input = record(request['input']) ?? {}
    const toolName = string(request['tool_name']) ?? 'tool'
    if (toolName === 'AskUserQuestion') {
      return {
        nativeSessionId,
        events: [
          {
            type: 'question.asked',
            sessionId: context.sessionId,
            requestId,
            questions: normalizeAgentQuestions(input),
            metadata: { transport: 'control', input, controlRequestId: requestId }
          }
        ]
      }
    }
    return {
      nativeSessionId,
      events: [
        {
          type: 'permission.asked',
          sessionId: context.sessionId,
          permission: {
            id: requestId,
            sessionId: context.sessionId,
            permission: toolName,
            patterns: permissionPatterns(input),
            metadata: { subtype: 'can_use_tool', toolName, input, request }
          }
        }
      ]
    }
  }

  if (type === 'system' && entry['subtype'] === 'api_retry') {
    const delayMs = numberProperty(entry, 'retry_delay_ms', 'retryDelayMs') ?? 0
    const rawError =
      serializeContent(entry['error']) ?? 'Claude Code is retrying the provider request'
    const statusCode = numberProperty(entry, 'error_status', 'errorStatus')
    const kind = claudeApiRetryKind(string(entry['error']), statusCode)
    return {
      nativeSessionId,
      events: [
        {
          type: 'session.status',
          sessionId: context.sessionId,
          status: {
            state: 'waiting',
            issue: {
              kind,
              message: 'Claude Code is waiting before retrying the provider request.',
              rawError,
              harnessId: 'claude-code',
              retryable: true,
              ...(statusCode === undefined ? {} : { statusCode }),
              ...(delayMs > 0 ? { retryAt: Date.now() + delayMs } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'assistant') {
    const rawMessage = record(entry['message'])
    if (!rawMessage) return nativeSessionId ? { nativeSessionId } : null
    const parentCallId = string(entry['parent_tool_use_id'])
    if (parentCallId) {
      const existing = findSubagentPart(context, parentCallId)
      if (!existing) return nativeSessionId ? { nativeSessionId } : null
      const resolvedModelId = string(rawMessage['model']) ?? string(entry['model'])
      const output = Array.isArray(rawMessage['content'])
        ? rawMessage['content']
            .map((block) => serializeContent(record(block)?.['text']))
            .filter((text): text is string => Boolean(text))
            .join('\n')
        : undefined
      const part: Extract<AgentPart, { type: 'subagent' }> = {
        ...existing,
        activity: {
          ...existing.activity,
          status: 'running',
          modelId: resolvedModelId ?? existing.activity.modelId,
          ...(output ? { output } : {})
        }
      }
      return {
        nativeSessionId,
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
    const incoming = messageFromAssistant(rawMessage)
    const existing = context.session.messages.find((message) => message.id === incoming.id)
    const mapped = existing ? mergeAssistantRecord(existing, incoming) : incoming
    const rawError = mapped.parts
      .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    const authenticationFailure = entry['error'] === 'authentication_failed'
    // The per-message assistant record reports its own usage before the final
    // result folds in the cumulative one; carry the normalized payload here too
    // so an interrupted turn still reaches the ledger with real categories.
    const normalizedUsage = mapped.tokens
      ? mapClaudeNormalizedUsage(rawMessage['usage'])
      : undefined
    const usageEvent = mapped.tokens
      ? [
          {
            type: 'usage.updated' as const,
            sessionId: context.sessionId,
            messageId: mapped.id,
            tokens: mapped.tokens,
            ...(normalizedUsage ? { normalizedUsage } : {})
          }
        ]
      : []
    return {
      nativeSessionId,
      messages: [normalizedUsage ? { ...mapped, normalizedUsage } : mapped],
      events: [
        { type: 'session.status', sessionId: context.sessionId, status: { state: 'working' } },
        ...mapped.parts.map((part) => ({
          type: 'message.part.updated' as const,
          sessionId: context.sessionId,
          part
        })),
        ...usageEvent,
        ...(authenticationFailure
          ? [
              {
                type: 'message.completed' as const,
                sessionId: context.sessionId,
                messageId: mapped.id,
                error: rawError || 'Claude Code authentication failed.',
                issue: {
                  kind: 'authentication' as const,
                  message: 'Claude Code sign-in expired. Sign in again, then retry this message.',
                  rawError: rawError || 'Claude Code authentication failed.',
                  harnessId: 'claude-code',
                  retryable: true
                }
              }
            ]
          : [])
      ]
    }
  }

  if (type === 'user') {
    const rawMessage = record(entry['message'])
    const content = rawMessage && Array.isArray(rawMessage['content']) ? rawMessage['content'] : []
    const parts: AgentPart[] = []
    for (const blockValue of content) {
      const block = record(blockValue)
      if (!block || block['type'] !== 'tool_result') continue
      const callId = string(block['tool_use_id'])
      if (!callId) continue
      const existingSubagent = findSubagentPart(context, callId)
      if (existingSubagent) {
        const output = serializeContent(block['content'])
        const failed = block['is_error'] === true
        // Claude Code can queue an Agent call as a background task: the tool
        // result is the async-launch marker and the real agent result arrives
        // later as a <task-notification> prompt in the same process. Keep the
        // part running (background) so the turn process is not torn down.
        const asyncLaunch = !failed && !!output && output.includes(CLAUDE_ASYNC_AGENT_LAUNCH_MARKER)
        parts.push({
          ...existingSubagent,
          activity: {
            ...existingSubagent.activity,
            status: failed ? 'error' : asyncLaunch ? 'running' : 'completed',
            background: asyncLaunch ? true : existingSubagent.activity.background,
            ...(output ? { output } : {}),
            ...(failed ? { error: output ?? 'Claude sub-agent task failed' } : {})
          }
        })
        continue
      }
      const existing = findToolPart(context, callId)
      if (!existing) continue
      const output = serializeContent(block['content'])
      const failed = block['is_error'] === true
      parts.push(
        toolPart(
          existing.messageID,
          callId,
          existing.tool,
          existing.state.input,
          failed ? 'error' : 'completed',
          output
        )
      )
    }
    if (!parts.length) {
      // A background agent finishing is delivered as a plain-text user turn
      // (<task-notification> with the launching tool-use-id). Complete the
      // matching subagent part so the UI and the stdin-close logic observe the
      // agent as finished. The stream-json transport may deliver the
      // notification text either as a bare string or wrapped in a text block;
      // both shapes must be recognized or the subagent part stays "running"
      // forever and the parent turn is never torn down.
      const notificationText =
        rawMessage && typeof rawMessage['content'] === 'string'
          ? rawMessage['content']
          : Array.isArray(rawMessage?.['content'])
            ? rawMessage['content']
                .filter(
                  (blockValue): blockValue is Record<string, unknown> =>
                    record(blockValue)?.['type'] === 'text'
                )
                .map((block) => string(block['text']) ?? '')
                .join('\n')
            : ''
      if (notificationText.includes('<task-notification>')) {
        const callId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notificationText)?.[1]
        const subagent = callId ? findSubagentPart(context, callId) : undefined
        if (
          subagent &&
          (subagent.activity.status === 'pending' || subagent.activity.status === 'running')
        ) {
          const resultText = /<result>([\s\S]*?)<\/result>/.exec(notificationText)?.[1]
          const part: AgentPart = {
            ...subagent,
            activity: {
              ...subagent.activity,
              status: 'completed',
              ...(resultText ? { output: resultText } : {})
            }
          }
          return {
            nativeSessionId,
            events: [{ type: 'message.part.updated' as const, sessionId: context.sessionId, part }]
          }
        }
      }
      return nativeSessionId ? { nativeSessionId } : null
    }
    const updated = parts.map((part) => ({
      type: 'message.part.updated' as const,
      sessionId: context.sessionId,
      part
    }))
    return { nativeSessionId, events: updated }
  }

  if (type === 'stream_event') {
    const event = record(entry['event'])
    const eventType = string(event?.['type'])
    if (eventType === 'message_start') {
      const rawMessage = record(event?.['message'])
      if (!rawMessage) return nativeSessionId ? { nativeSessionId } : null
      const incoming = messageFromAssistant(rawMessage)
      const existing = context.session.messages.find((message) => message.id === incoming.id)
      return {
        nativeSessionId,
        messages: [existing ? mergeAssistantRecord(existing, incoming) : incoming]
      }
    }
    const current = latestAssistant(context)
    if (eventType === 'content_block_start' && current) {
      const block = record(event?.['content_block'])
      // Claude streams tool blocks before their JSON input. Promoting an empty
      // AskUserQuestion block creates a fallback question that races the
      // completed assistant record and native can_use_tool request. Wait for
      // either complete record, both of which carry the real question input.
      if (block?.['type'] === 'tool_use' && string(block['name']) === 'AskUserQuestion') {
        return nativeSessionId ? { nativeSessionId } : null
      }
      const index = number(event?.['index']) ?? current.parts.length
      const part = block ? partFromBlock(current.id, block, index) : null
      return part
        ? {
            nativeSessionId,
            events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
          }
        : nativeSessionId
          ? { nativeSessionId }
          : null
    }
    if (eventType === 'message_delta' && current) {
      const tokens = tokenUsage(event?.['usage'])
      const normalizedUsage = tokens ? mapClaudeNormalizedUsage(event?.['usage']) : undefined
      return tokens
        ? {
            nativeSessionId,
            events: [
              {
                type: 'usage.updated',
                sessionId: context.sessionId,
                messageId: current.id,
                tokens,
                ...(normalizedUsage ? { normalizedUsage } : {})
              }
            ]
          }
        : nativeSessionId
          ? { nativeSessionId }
          : null
    }
    const delta = event && record(event['delta'])
    if (eventType !== 'content_block_delta' || !delta || !current) {
      return nativeSessionId ? { nativeSessionId } : null
    }
    const deltaType = string(delta['type'])
    const text =
      deltaType === 'thinking_delta'
        ? string(delta['thinking'])
        : deltaType === 'text_delta'
          ? string(delta['text'])
          : undefined
    if (!text) return nativeSessionId ? { nativeSessionId } : null
    const index = number(event['index']) ?? 0
    const partKind = deltaType === 'thinking_delta' ? 'thinking' : 'text'
    return {
      nativeSessionId,
      events: [
        {
          type: 'message.part.delta',
          sessionId: context.sessionId,
          messageId: current.id,
          partId: `claude-${partKind}-${current.id}-${index}`,
          field: 'text',
          delta: text
        }
      ]
    }
  }

  if (type === 'rate_limit_event') {
    const info = entry['rate_limit_info'] ?? entry['rateLimitInfo']
    const limits = rateLimitWindows(info)
    const latest = latestAssistant(context)
    const details = record(info)
    const status = string(details?.['status'])
    const retryAt = epochMilliseconds(details?.['resetsAt'] ?? details?.['resets_at'])
    return {
      nativeSessionId,
      events: [
        ...(latest && limits.length > 0
          ? [
              {
                type: 'usage.updated' as const,
                sessionId: context.sessionId,
                messageId: latest.id,
                rateLimits: limits
              }
            ]
          : []),
        ...(status === 'rejected'
          ? [
              {
                type: 'session.error' as const,
                sessionId: context.sessionId,
                error: 'Claude session limit reached.',
                issue: {
                  kind: 'quota' as const,
                  message: 'Claude session limit reached.',
                  harnessId: 'claude-code',
                  retryable: retryAt !== undefined,
                  ...(retryAt === undefined ? {} : { retryAt })
                }
              }
            ]
          : [])
      ]
    }
  }

  if (type === 'result') {
    const latest = latestAssistant(context)
    const modelUsage = aggregateModelUsage(entry['modelUsage'] ?? entry['model_usage'])
    const tokens = preserveReasoningUsage(
      tokenUsage(entry['usage']) ?? modelUsage.tokens,
      latest?.tokens
    )
    // The streamed delta can report thinking tokens the final result usage
    // omits; keep the normalized reasoning aligned with the preserved display
    // count so the ledger records what the turn actually spent.
    const normalizedUsage = preserveNormalizedReasoning(
      mapClaudeNormalizedUsage(entry['usage']) ?? modelUsage.normalizedUsage,
      tokens
    )
    const cost = numberProperty(entry, 'total_cost_usd', 'totalCostUsd') ?? modelUsage.cost
    const contextWindow =
      numberProperty(entry, 'context_window', 'contextWindow') ?? modelUsage.contextWindow
    const contextUsed =
      numberProperty(entry, 'context_used', 'contextUsed', 'current_usage') ??
      latestIterationContextUsed(entry['usage'])
    const reportedRateLimits = rateLimitWindows(entry['rate_limits'] ?? entry['rateLimits'])
    const structuredOutput = entry['structured_output'] ?? entry['structuredOutput']
    const error =
      entry['subtype'] === 'success' && entry['is_error'] !== true
        ? undefined
        : (string(entry['result']) ?? string(entry['subtype']) ?? 'Claude Code turn failed')
    const inheritedRateLimits = claudeSessionLimitIssue(error, [])
      ? latestClaudeRateLimits(context)
      : []
    const rateLimits = reportedRateLimits.length > 0 ? reportedRateLimits : inheritedRateLimits
    const issue = claudeSessionLimitIssue(error, rateLimits) ?? claudeResultIssue(error)
    const completedAt = Date.now()
    const terminalSubagentEvents: SessionAgentEvent[] = activeClaudeSubagentParts(
      context,
      false
    ).map((part) => ({
      type: 'message.part.updated',
      sessionId: context.sessionId,
      part: {
        ...part,
        activity: {
          ...part.activity,
          status: error ? 'error' : 'completed',
          ...(error ? { error } : {}),
          ...(part.activity.time ? { time: { ...part.activity.time, end: completedAt } } : {})
        }
      }
    }))
    return {
      nativeSessionId,
      events: latest
        ? [
            ...terminalSubagentEvents,
            ...(tokens ||
            normalizedUsage ||
            cost !== undefined ||
            contextWindow !== undefined ||
            contextUsed !== undefined ||
            rateLimits.length > 0
              ? [
                  {
                    type: 'usage.updated' as const,
                    sessionId: context.sessionId,
                    messageId: latest.id,
                    ...(tokens ? { tokens } : {}),
                    ...(normalizedUsage ? { normalizedUsage } : {}),
                    ...(cost === undefined ? {} : { cost }),
                    ...(contextWindow === undefined ? {} : { contextWindow }),
                    ...(contextUsed === undefined ? {} : { contextUsed }),
                    ...(rateLimits.length > 0 ? { rateLimits } : {})
                  }
                ]
              : []),
            {
              type: 'message.completed',
              sessionId: context.sessionId,
              messageId: latest.id,
              error,
              ...(tokens ? { tokens } : {}),
              ...(normalizedUsage ? { normalizedUsage } : {}),
              ...(contextWindow === undefined ? {} : { contextWindow }),
              ...(contextUsed === undefined ? {} : { contextUsed }),
              ...(rateLimits.length > 0 ? { rateLimits } : {}),
              ...(issue ? { issue } : {}),
              ...(structuredOutput === undefined ? {} : { structuredOutput })
            }
          ]
        : error
          ? [
              ...terminalSubagentEvents,
              {
                type: 'session.error',
                sessionId: context.sessionId,
                error,
                ...(issue ? { issue } : {})
              }
            ]
          : terminalSubagentEvents
    }
  }
  return nativeSessionId ? { nativeSessionId } : null
}
