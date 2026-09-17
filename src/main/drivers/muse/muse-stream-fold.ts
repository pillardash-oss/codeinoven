import type { SessionAgentEvent } from '../../../lib/types'
import { isQuestionToolName, isTodoToolName } from '../../../lib/agent-interactions'
import type {
  CliLineParseContext,
  CliLineParseResult
} from '../persistent-cli/persistent-cli-types'
import {
  museIssue,
  musePermissionEvent,
  museToolName,
  normalizeMuseQuestions
} from './muse-interactions'
import {
  isMuseSubagentSpawn,
  museApplyChunkFields,
  museApplyResultText,
  museCompactionResult,
  museCompleteTool,
  museFinalizeInterruptedTools,
  museMessage,
  museSubagentEvent,
  museToolEvent,
  museToolForCall,
  normalizeMuseWorktreeIsolation,
  reasoningPart,
  textPart,
  upsertPart
} from './muse-parts'
import type { MuseToolState, MuseTurnState } from './muse-parts'
import { firstString, parseRecord, record, stringValue } from './muse-values'

/**
 * Map one `muse exec --json` envelope into CodeInOven's stable shapes.
 *
 * Every line is `{ record_type, payload_type, payload }`; the meaningful
 * payloads are `run.output.delta` (streaming text), reasoning deltas
 * (`run.output.reasoning.delta` / `run.reasoning.delta` / `run.thinking.delta`),
 * `run.terminal.completed` (turn end), and `run.model.configured` (provenance).
 * The top-level session stream ids are observed only as event metadata and are
 * never reused for native conversation history.
 *
 * Unknown record types are ignored so schema drift degrades to a silent turn
 * rather than a broken session. Keeping this boundary pure makes it testable.
 */
export function mapMuseRecord(
  value: unknown,
  context: CliLineParseContext,
  state: MuseTurnState
): CliLineParseResult | null {
  const entry = record(value)
  const payload = record(entry?.['payload'])
  if (!entry || !payload) return null

  const base: CliLineParseResult = {}

  const payloadType = stringValue(entry['payload_type'])
  const taskId = stringValue(payload['task_id'])
  if (payloadType?.includes('approval')) {
    if (
      payloadType.includes('request') ||
      payloadType.includes('proposed') ||
      payloadType.includes('pending')
    ) {
      const approvalEvent = musePermissionEvent(context, state, record(payload['event']) ?? payload)
      if (approvalEvent) return { ...base, events: [approvalEvent] }
    }
  }

  if (payloadType === 'runtime.session') {
    const exportedEvent = record(payload['event'])
    if (!exportedEvent) return base
    const kind = stringValue(exportedEvent['kind'])

    // Reasoning trace   Muse 1.x does not stream reasoning on the headless
    // stdout at all; the plaintext reasoning summary (and, for providers that
    // expose it, the raw reasoning delta) is only persisted to the durable
    // session log. The driver tails that log during the turn and replays these
    // records through this branch so the ThinkingBlock renders live content.
    if (
      kind === 'reasoning_summary_delta' ||
      kind === 'reasoning_summary_committed' ||
      kind === 'reasoning_delta' ||
      kind === 'reasoning_committed'
    ) {
      const delta = stringValue(exportedEvent['text']) ?? stringValue(exportedEvent['delta'])
      if (!delta) return base
      if (!state.reasoningTime?.start) state.reasoningTime = { start: Date.now() }
      if (kind === 'reasoning_summary_delta') {
        state.reasoningSummary = (state.reasoningSummary ?? '') + delta
      } else if (kind === 'reasoning_summary_committed') {
        // Committed text is authoritative for its block; later deltas belong
        // to the next summary block, so replace rather than append.
        state.reasoningSummary = delta
      } else if (kind === 'reasoning_delta') {
        state.reasoning += delta
      } else if (delta.length > state.reasoning.length) {
        state.reasoning = delta
        state.reasoningTime = { ...state.reasoningTime, end: Date.now() }
      }
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }

    // Session-log mirror of `task.lifecycle.output`   same chunk shape, so
    // backfill the tool card when the live stream missed the chunk (e.g. the
    // run was stopped for a permission gate right after the call started).
    if (kind === 'output') {
      const outTaskId = stringValue(exportedEvent['task_id'])
      const chunk = stringValue(exportedEvent['chunk'])
      const tool = outTaskId ? state.tools.get(outTaskId) : undefined
      if (!tool || !chunk) return base
      museApplyChunkFields(tool, chunk)
      if (isQuestionToolName(tool.tool)) return base
      if (isMuseSubagentSpawn(tool.tool)) {
        return { ...base, events: [museSubagentEvent(context, state, tool)] }
      }
      return { ...base, events: [museToolEvent(context, state, tool)] }
    }

    // Session-log mirror of `tool.result` batches   authoritative completion
    // backfill for tool cards whose stdout result never arrived.
    if (kind === 'tool_result_batch_committed') {
      const results = Array.isArray(exportedEvent['results']) ? exportedEvent['results'] : []
      const events: SessionAgentEvent[] = []
      for (const rawResult of results) {
        const resultRow = record(rawResult)
        const callId = stringValue(resultRow?.['tool_call_id'])
        const text = stringValue(resultRow?.['text'])
        if (!callId) continue
        const settledTaskId = state.toolByCall.get(callId)
        const tool = settledTaskId ? state.tools.get(settledTaskId) : undefined
        if (!tool || tool.status === 'completed' || tool.status === 'error') continue
        const settled = museCompleteTool(context, state, tool, text, false)
        if (settled) events.push(settled)
      }
      return events.length > 0 ? { ...base, events } : base
    }

    if (kind === 'assistant_tool_calls_committed') {
      const calls = Array.isArray(exportedEvent['tool_calls']) ? exportedEvent['tool_calls'] : []
      const events: SessionAgentEvent[] = []
      for (const rawCall of calls) {
        const call = record(rawCall)
        const callId = stringValue(call?.['call_id'])
        const toolName = stringValue(call?.['name'])
        if (!callId || !toolName) continue
        const tool = museToolForCall(state, toolName, callId)
        if (!tool) continue
        const input = parseRecord(call?.['args'])
        if (input) {
          normalizeMuseWorktreeIsolation(input)
          tool.input = input
        }
        tool.callId = callId
        state.toolByCall.set(callId, tool.taskId)
        if (isMuseSubagentSpawn(tool.tool)) {
          events.push(museSubagentEvent(context, state, tool))
        } else {
          events.push(museToolEvent(context, state, tool))
        }
        if (
          tool.requiresPermission ||
          (tool.policyDecision &&
            !tool.policyDecision.startsWith('allow') &&
            tool.policyDecision !== 'not_applicable')
        ) {
          // Surface the card only once   and only after the committed args are
          // available so the permission carries the actual command.
          if (!tool.requiresPermission || !state.emittedPermissionTasks.has(tool.taskId)) {
            const permissionEvent = musePermissionEvent(context, state, {
              approval_id: callId,
              tool_name: toolName,
              input: tool.input
            })
            if (permissionEvent) {
              if (tool.requiresPermission) state.emittedPermissionTasks.add(tool.taskId)
              events.push(permissionEvent)
            }
          }
        }
      }
      return events.length > 0 ? { ...base, events } : base
    }

    if (kind === 'todo_snapshot_updated') {
      const items = Array.isArray(exportedEvent['items']) ? exportedEvent['items'] : []
      const tool = [...state.tools.values()].findLast((candidate) => isTodoToolName(candidate.tool))
      if (!tool || items.length === 0) return base
      tool.input = { todos: items }
      return { ...base, events: [museToolEvent(context, state, tool)] }
    }

    if (kind === 'user_input_prompt_requested') {
      const requestId =
        firstString(exportedEvent['tool_call_id'], exportedEvent['prompt_id']) ?? taskId
      if (!requestId || state.promotedInteractions.has(`question:${requestId}`)) return base
      const tool = museToolForCall(state, 'request_user_input', requestId)
      if (tool && Object.keys(tool.input).length === 0) {
        tool.input = { questions: exportedEvent['questions'] }
      }
      const questions = normalizeMuseQuestions(
        tool?.input ?? { questions: exportedEvent['questions'] }
      )
      state.promotedInteractions.add(`question:${requestId}`)
      return {
        ...base,
        events: [
          ...(tool ? [museToolEvent(context, state, tool)] : []),
          {
            type: 'question.asked',
            sessionId: context.sessionId,
            requestId,
            questions,
            ...(tool
              ? { tool: { messageID: state.messageId, callID: tool.callId ?? requestId } }
              : {})
          }
        ]
      }
    }

    if (
      kind?.includes('approval') &&
      (kind.includes('request') || kind.includes('proposed') || kind.includes('pending'))
    ) {
      const event = musePermissionEvent(context, state, exportedEvent)
      return event ? { ...base, events: [event] } : base
    }
    if (kind && kind.toLowerCase().includes('compaction')) {
      const summary = firstString(
        stringValue(exportedEvent['summary']),
        stringValue(exportedEvent['text']),
        stringValue(exportedEvent['compact_summary']),
        stringValue(exportedEvent['summary_text']),
        stringValue(payload['summary']),
        stringValue(payload['text'])
      )
      const trigger = stringValue(exportedEvent['trigger']) ?? stringValue(exportedEvent['kind'])
      const auto = trigger ? trigger !== 'manual' : true
      const overflow = trigger === 'auto'
      return {
        ...base,
        ...museCompactionResult(context, state, summary, auto, overflow || undefined)
      }
    }
    return base
  }

  // Harness-native context compaction   emitted by Muse when the soft/hard
  // threshold fires (summary-preserved-suffix/v1). Mirror it as a CodeInOven
  // compaction checkpoint so the next turn's history recap slices from that cut
  // and continues seamlessly instead of replaying the full pre-compaction
  // transcript.
  if (payloadType && payloadType.toLowerCase().includes('compaction')) {
    const eventRec = record(payload['event'])
    const summary = firstString(
      stringValue(payload['summary']),
      stringValue(payload['text']),
      stringValue(payload['compact_summary']),
      stringValue(payload['summary_text']),
      stringValue(eventRec?.['summary']),
      stringValue(eventRec?.['text']),
      stringValue(eventRec?.['compact_summary']),
      stringValue(eventRec?.['summary_text'])
    )
    const trigger =
      stringValue(payload['trigger']) ??
      stringValue(eventRec?.['trigger']) ??
      stringValue(eventRec?.['kind'])
    const auto = trigger ? trigger !== 'manual' : true
    const overflow = trigger === 'auto' || payloadType.toLowerCase().includes('overflow')
    return {
      ...base,
      ...museCompactionResult(context, state, summary, auto, overflow || undefined)
    }
  }

  // Tool call proposed   announce a pending tool card in the working trace.
  // Muse sub-agents (`subagent_spawn`) are rendered as `type:'subagent'` so CodeInOven shows proper cards.
  // Normalize worktree_isolation to false (shared)   CodeInOven owns worktree lifecycle.
  // (normalization also done in museSubagentPart)
  // WorkingTrace shows SubagentCard + the header chip/sheet instead of a flat
  // generic tool card.
  if (payloadType === 'task.lifecycle.proposed') {
    const event = record(payload['event'])
    const taskKind = museToolName(event?.['task_kind'], 'task_kind')
    if (taskId && taskKind) {
      const tool: MuseToolState = {
        taskId,
        tool: taskKind,
        status: 'pending',
        input: record(event?.['input']) ?? record(event?.['arguments']) ?? {},
        ...(state.gatedTaskIds.has(taskId) ? { requiresPermission: true } : {}),
        start: Date.now()
      }
      state.tools.set(taskId, tool)
      // CodeInOven owns worktree lifecycle   force shared worktree for any subagent spawn.
      normalizeMuseWorktreeIsolation(tool.input)
      if (isMuseSubagentSpawn(taskKind)) {
        return { ...base, events: [museSubagentEvent(context, state, tool)] }
      }
      if (tool.requiresPermission) {
        // Deliberately do NOT emit the permission card here: Muse streams the
        // command after `proposed` (`assistant_tool_calls_committed` /
        // `task.lifecycle.output`), so a card emitted on this record would
        // surface empty details. Keep the pending tool card and surface the
        // permission once the command is known.
        return { ...base, events: [museToolEvent(context, state, tool)] }
      }
      // The live stream does not expose the rich question arguments. Keep the
      // generic tool out of the conversation rather than duplicating the
      // provider's own headless auto-resolution.
      if (isQuestionToolName(taskKind)) return base
      return { ...base, events: [museToolEvent(context, state, tool)] }
    }
    return base
  }

  if (payloadType === 'task.lifecycle.scheduled') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool) return base
    const idempotencyKey = stringValue(record(payload['event'])?.['idempotency_key'])
    const callId = idempotencyKey?.split(':').find((segment) => segment.startsWith('call_'))
    if (callId) {
      tool.callId = callId
      state.toolByCall.set(callId, tool.taskId)
    }
    return base
  }

  // Tool call accepted for execution   flip to running and record the provider
  // call id (also the key used later by `tool.result`).
  if (payloadType === 'task.lifecycle.side_effect_intent') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool) return base
    const event = record(payload['event'])
    const policyDecision = stringValue(event?.['policy_decision'])
    if (policyDecision) {
      tool.policyDecision = policyDecision
    }
    const idempotencyKey = stringValue(event?.['idempotency_key'])
    const foundCallId = idempotencyKey?.split(':').find((segment) => segment.startsWith('call_'))
    if (foundCallId && taskId) {
      tool.callId = foundCallId
      state.toolByCall.set(foundCallId, taskId)
    }
    tool.status = 'running'
    let sideEffectEvents: SessionAgentEvent[] = []
    if (tool.requiresPermission && !state.emittedPermissionTasks.has(tool.taskId)) {
      const permissionEvent = musePermissionEvent(context, state, {
        approval_id: tool.callId ?? taskId,
        tool_name: tool.tool,
        input: tool.input
      })
      if (permissionEvent) {
        state.emittedPermissionTasks.add(tool.taskId)
        sideEffectEvents = [permissionEvent]
      }
    }
    if (isMuseSubagentSpawn(tool.tool)) {
      return {
        ...base,
        events: [museSubagentEvent(context, state, tool), ...sideEffectEvents]
      }
    }
    if (isQuestionToolName(tool.tool)) return base
    return {
      ...base,
      events: [museToolEvent(context, state, tool), ...sideEffectEvents]
    }
  }

  // Tool output chunk   for bash it is a JSON `{command, description, output}`;
  // for write/read it is the human-readable result. Prefer `tool.result` for the
  // authoritative completion; this fills the input/title early so the card is
  // meaningful while still running.
  if (payloadType === 'task.lifecycle.output') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool) return base
    const chunk = stringValue(record(payload['event'])?.['chunk'])
    if (!chunk) return base
    museApplyChunkFields(tool, chunk)
    let outputEvents: SessionAgentEvent[] = []
    if (
      tool.requiresPermission &&
      !state.emittedPermissionTasks.has(tool.taskId) &&
      typeof tool.input['command'] === 'string' &&
      tool.input['command'].trim().length > 0
    ) {
      const permissionEvent = musePermissionEvent(context, state, {
        approval_id: tool.callId ?? taskId,
        tool_name: tool.tool,
        input: tool.input
      })
      if (permissionEvent) {
        state.emittedPermissionTasks.add(tool.taskId)
        outputEvents = [permissionEvent]
      }
    }
    if (isMuseSubagentSpawn(tool.tool)) {
      return {
        ...base,
        events: [museSubagentEvent(context, state, tool), ...outputEvents]
      }
    }
    if (isQuestionToolName(tool.tool)) return base
    return {
      ...base,
      events: [museToolEvent(context, state, tool), ...outputEvents]
    }
  }

  // Tool result   authoritative completion; correlate by provider call id.
  if (payloadType === 'tool.result') {
    const callId = stringValue(payload['call_id'])
    const taskIdFromCall = callId ? state.toolByCall.get(callId) : undefined
    const tool = taskIdFromCall ? state.tools.get(taskIdFromCall) : undefined
    if (!tool) return base
    const facts = record(payload['correlation_facts'])
    const outcome = stringValue(facts?.['outcome'])
    const text = stringValue(payload['text'])
    const failed = outcome === 'failure' || outcome === 'error'
    tool.status = failed ? 'error' : 'completed'
    if (text) museApplyResultText(tool, text)
    // `edit_facts.path` is the project-relative file that the tool changed.
    // Surfacing it as the tool input lets the checkpoint change tracker map the
    // edit to a concrete path, so the working-trace diff and rollback capture
    // the model's edits (not just the user's own changes).
    const editFacts = record(payload['edit_facts'])
    const editedPath = stringValue(editFacts?.['path'])
    if (editedPath) {
      tool.input = { path: editedPath, ...tool.input }
      if (!tool.title) tool.title = editedPath
    }
    tool.end = Date.now()
    if (isQuestionToolName(tool.tool)) return base
    if (isMuseSubagentSpawn(tool.tool)) {
      return { ...base, events: [museSubagentEvent(context, state, tool)] }
    }
    return { ...base, events: [museToolEvent(context, state, tool)] }
  }

  // Tool lifecycle completion   Muse 1.x never re-emits the committed tool
  // call and `tool.result` is absent for non-shell tools, so without this
  // handler completed tool cards would stay `running` forever with an empty
  // input. Flip the matching task to `completed` when its lifecycle closes.
  if (payloadType === 'task.lifecycle.completed') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool || tool.status === 'completed' || tool.status === 'error') return base
    tool.status = 'completed'
    tool.end = Date.now()
    if (isQuestionToolName(tool.tool)) return base
    if (isMuseSubagentSpawn(tool.tool))
      return { ...base, events: [museSubagentEvent(context, state, tool)] }
    return { ...base, events: [museToolEvent(context, state, tool)] }
  }

  // Tool task closed without executing   Muse policy rejected the call (or the
  // run cancelled/timed it out). Without this the card stays pending forever.
  if (
    payloadType === 'task.lifecycle.rejected' ||
    payloadType === 'task.lifecycle.cancelled' ||
    payloadType === 'task.lifecycle.failed'
  ) {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool || tool.status === 'completed' || tool.status === 'error') return base
    const event = record(payload['event'])
    const detail =
      stringValue(event?.['reason']) ??
      stringValue(event?.['detail']) ??
      stringValue(event?.['message'])
    const label = payloadType.endsWith('rejected')
      ? 'Rejected by Muse policy'
      : payloadType.endsWith('cancelled')
        ? 'Cancelled by Muse'
        : 'Failed in Muse'
    tool.error = detail ? `${label}: ${detail}` : label
    const settled = museCompleteTool(context, state, tool, undefined, true)
    return settled ? { ...base, events: [settled] } : base
  }

  // Muse Spark always reasons; ensure the working trace shows a ThinkingBlock
  // immediately when the run starts so the user sees "Thinking …" even though
  // the CLI inlines reasoning into `run.output.delta` text rather than a
  // separate reasoning delta channel. The block stays active until the terminal
  // record closes it.
  if (payloadType === 'run.lifecycle.started') {
    if (!state.reasoningTime?.start) state.reasoningTime = { start: Date.now() }
    // Emit an initial empty reasoning part so WorkingTrace renders ThinkingBlock
    // during the busy phase. Subsequent reasoning deltas (if any) append to it.
    if (!state.parts.some((p) => p.type === 'reasoning')) {
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
  }

  // Streaming reasoning trace   Muse Spark reasoning effort produces
  // provider-side thinking that the CLI surfaces as a separate delta channel.
  // The current CLI (0.2.1) inlines reasoning into `run.output.delta` text for
  // most turns, but any future `*reasoning*` / `*thinking*` payload is captured
  // here so the working trace renders a distinct `ThinkingBlock` instead of
  // silently dropping the trace. Also handles generic payloads that carry
  // `reasoning`/`thinking` keys regardless of payload_type.
  if (
    payloadType === 'run.output.reasoning.delta' ||
    payloadType === 'run.reasoning.delta' ||
    payloadType === 'run.thinking.delta' ||
    payloadType === 'run.output.thinking.delta' ||
    (payloadType !== undefined &&
      (payloadType.includes('reasoning') || payloadType.includes('thinking')))
  ) {
    const delta =
      stringValue(payload['text']) ??
      stringValue(payload['delta']) ??
      stringValue(payload['reasoning']) ??
      stringValue(payload['thinking']) ??
      stringValue(payload['content']) ??
      stringValue(record(payload['event'])?.['delta']) ??
      stringValue(record(payload['event'])?.['thinking'])
    const summary =
      stringValue(payload['summary']) ?? stringValue(record(payload['event'])?.['summary'])
    if (summary) state.reasoningSummary = summary
    if (delta) {
      if (!state.reasoningTime?.start) {
        state.reasoningTime = { start: Date.now(), ...state.reasoningTime }
      }
      state.reasoning += delta
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
    if (summary) {
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
    return base
  }

  // Streaming assistant text   `payload.text` is an incremental delta.
  if (payloadType === 'run.output.delta') {
    const delta = stringValue(payload['text'])
    if (delta) {
      state.text += delta
      upsertPart(state, textPart(state))
      return {
        ...base,
        messages: [museMessage(state)],
        events: [
          { type: 'message.part.updated', sessionId: context.sessionId, part: textPart(state) }
        ]
      }
    }
    return base
  }

  // Generic reasoning payload   captures any envelope that carries reasoning/
  // thinking content even when payload_type does not contain those words.
  {
    const genericDelta =
      stringValue(payload['reasoning']) ??
      stringValue(payload['thinking']) ??
      stringValue(payload['reasoning_text']) ??
      stringValue(payload['reasoning_content']) ??
      stringValue(record(payload['event'])?.['reasoning']) ??
      stringValue(record(payload['event'])?.['thinking'])
    const genericSummary =
      stringValue(payload['reasoning_summary']) ?? stringValue(payload['summary'])
    if (
      genericDelta &&
      payloadType !== 'run.output.delta' &&
      payloadType !== 'run.terminal.completed' &&
      payloadType !== 'run.lifecycle.started'
    ) {
      if (!state.reasoningTime?.start) state.reasoningTime = { start: Date.now() }
      state.reasoning += genericDelta
      if (genericSummary) state.reasoningSummary = genericSummary
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
  }

  // Turn end   `payload.terminal` is `completed` on success, anything else is an
  // error. `payload.text` is the authoritative final text.
  if (payloadType === 'run.terminal.completed') {
    const terminal = stringValue(payload['terminal'])
    const finalText = stringValue(payload['text'])
    const reason = stringValue(payload['reason'])
    const finalReasoning =
      stringValue(payload['reasoning']) ??
      stringValue(payload['thinking']) ??
      stringValue(payload['reasoning_text'])
    const finalReasoningSummary =
      stringValue(payload['reasoning_summary']) ?? stringValue(payload['summary'])
    if (finalReasoningSummary) state.reasoningSummary = finalReasoningSummary
    if (finalReasoning && finalReasoning.length > state.reasoning.length) {
      state.reasoning = finalReasoning
      state.reasoningTime = { ...(state.reasoningTime ?? {}), end: Date.now() }
      upsertPart(state, reasoningPart(state))
    } else if ((state.reasoning || state.reasoningTime?.start) && !state.reasoningTime?.end) {
      state.reasoningTime = { ...(state.reasoningTime ?? {}), end: Date.now() }
      upsertPart(state, reasoningPart(state))
    }
    if (finalText) {
      state.text = finalText
      upsertPart(state, textPart(state))
    }
    const failed = terminal !== 'completed'
    const error = failed ? (reason ?? finalText ?? 'Muse run failed') : undefined

    if (state.started) {
      const events: SessionAgentEvent[] = []
      if (finalText) {
        events.push({
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: textPart(state)
        })
      }
      // Close out tool cards that outlived the run (no result reported) so
      // they never spin forever with empty details.
      events.push(...museFinalizeInterruptedTools(context, state))
      // A gated tool can still be stopped before the stream carries its
      // command (the `proposed` record gates immediately). Surface the pending
      // permission at turn end with whatever arguments were captured so the
      // user can still approve or reject instead of the request vanishing.
      for (const tool of state.tools.values()) {
        if (!tool.requiresPermission || state.emittedPermissionTasks.has(tool.taskId)) continue
        const permissionEvent = musePermissionEvent(context, state, {
          approval_id: tool.callId ?? tool.taskId,
          tool_name: tool.tool,
          input: tool.input
        })
        if (permissionEvent) {
          state.emittedPermissionTasks.add(tool.taskId)
          events.push(permissionEvent)
        }
      }
      events.push({
        type: 'message.completed',
        sessionId: context.sessionId,
        messageId: state.messageId,
        ...(error ? { error, issue: museIssue(error) } : {})
      })
      return { ...base, messages: [museMessage(state)], events }
    }
    if (error) {
      return {
        ...base,
        events: [
          { type: 'session.error', sessionId: context.sessionId, error, issue: museIssue(error) }
        ]
      }
    }
    return base
  }

  return base
}
