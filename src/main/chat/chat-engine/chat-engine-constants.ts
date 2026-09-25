import { Logger } from '../../system/logger'
import type { BehaviorExecutionScope, BehaviorMode } from '../prompt-assembler'
import type { AttributionMode } from '../token-usage-attribution'
import { leanAgentNameForMode } from '../../opencode/opencode-agent-definitions'
import type { LeanAgentMode } from '../../opencode/opencode-agent-definitions'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type {
  AgentCapabilityEntry,
  PermissionLevel,
  PromptAttachment,
  SessionAgentEvent
} from '../../../lib/types'

export const PROVIDER_CATALOG_TTL_MS = 60 * 60 * 1000

/** How long a resolved agent tool catalog stays fresh before re-discovery. */
export const TOOL_CATALOG_TTL_MS = 30 * 1000

/**
 * A terminal sub-agent card patch (completed / failed / stopped) reports a
 * worker that has already ended. It is bookkeeping for the card, never
 * evidence of new work: treating it as activity flips the thread's live
 * "working" state back on   which is exactly what a stopped worker's card did
 * seconds after the user stopped the thread.
 */
export function isTerminalSubagentPatch(event: SessionAgentEvent): boolean {
  if (event.type !== 'message.part.updated' || event.part.type !== 'subagent') return false
  const status = event.part.activity.status
  return status === 'completed' || status === 'error' || status === 'aborted'
}

/**
 * A driver signal that the session settled: the dedicated `session.idle` event
 * or an idle `session.status`. Both mean the same thing to every consumer, and
 * both are only the turn's end when the emitting driver has released the turn
 * (see ChatEngine's `driverHoldsTurn`).
 */
export function isIdleSignalEvent(event: SessionAgentEvent): boolean {
  return (
    event.type === 'session.idle' ||
    (event.type === 'session.status' && event.status.state === 'idle')
  )
}

/**
 * Cooldown used to schedule an automatic retry for a quota/rate-limit wait
 * when the provider's error carries no parseable reset time (or one already
 * in the past). Without this, such a wait would show no timer and never
 * auto-resume   see scheduleAutomaticRetry.
 */
export const USAGE_RESET_FALLBACK_RETRY_MS = 60 * 60 * 1000

/** Grace added to every provider-reported reset before the auto-resume fires.
 *  Firing on the exact reset second races the provider's own window rollover:
 *  the resumed turn re-fails while the limit is still active and the thread
 *  drops straight back into the wait (observed with Codex on 2026-09-07). */
export const RETRY_FIRE_GRACE_MS = 90 * 1000

export const LOOP_MAX_ITERATIONS = 8

/** How long a transferring instance waits for the departing instance's aborted
 *  turn to release the shared `active_turns` row before forcing the release. */
export const TRANSFER_SETTLE_TIMEOUT_MS = 6_000

/** Poll interval for that bounded wait. */
export const TRANSFER_SETTLE_POLL_MS = 100

export const ACTIONABLE_AUDIT_SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])

export const DEFAULT_QUESTION_TIMEOUT_MS = 300_000

/** Conservative tokens reserved for the final system/behavior/tool prompt
 *  beyond the estimated base (spec revision prompts, chat variations). */
export const SYSTEM_LAYER_RESERVE_TOKENS = 2_048

/** Upper bound given to the recap layer so it takes all remaining headroom. */
export const MAX_RECAP_TOKENS = 2_000_000

/** How long an image-descriptor failure waits for a user decision before auto-ignoring. */
export const IMAGE_DESCRIPTOR_DECISION_TIMEOUT_MS = 300_000

export const INCOMPLETE_TURN_MESSAGE =
  'The harness ended the turn without returning a final response. The task may be incomplete.'

export const INCOMPLETE_TURN_CONTINUATION_PROMPT =
  'Your previous turn ended without a final response. Continue the same task from where you stopped, finish any remaining work, verify it, and return a complete final response to the user.'

export const SPEC_CONTRACT_COMPLETE_MARKER = 'SPEC CONTRACT COMPLETE'

export const SPEC_CONTRACT_BLOCKED_MARKER = 'SPEC CONTRACT BLOCKED'

export const SPEC_CONTRACT_CONTINUATION_PROMPT = 'COMPLETE THE TOTAL SPEC CONTRACT!'

export const SPEC_GENERATION_MAX_ATTEMPTS = 3

export const CURRENT_SPEC_GENERATION_VERSION = 1

export const SPEC_GENERATION_FAILURE_USER_MESSAGE =
  'Spec generation failed, model returned an invalid spec.'

export const SPEC_MEMORY_MAX_LESSONS = 12

export const MAX_SPEC_INSTRUCTIONS_LENGTH = 200_000

/** How long after a user's last terminal keystroke the user-activity window
 *  stays open, covering commands that finish writing files after Enter. */
export const USER_TERMINAL_SETTLE_MS = 10_000

export const COORDINATOR_HANDOFF_QUEUE_DIR = 'coordinator-handoff-queue'

export const MAX_COORDINATOR_HANDOFFS = 50

/** Dev-only trace of the lean opencode agent selected for a trimmed mode. */
export function traceLeanAgent(mode: LeanAgentMode, sessionId: string, driverId: string): void {
  if (driverId === 'opencode') {
    Logger.dev('trimmed mode selected lean opencode agent', {
      mode,
      agent: leanAgentNameForMode(mode),
      sessionId
    })
  }
}

/** Map a turn's behavior mode/scope into the dev-only attribution mode label. */
export function attributionModeFor(
  mode: BehaviorMode,
  executionScope: BehaviorExecutionScope,
  fileSystemMode: boolean
): AttributionMode {
  if (executionScope === 'project-thread') return 'engineering'
  if (executionScope === 'assistant') return 'assistant'
  if (executionScope === 'ephemeral') return 'ephemeral'
  return fileSystemMode ? 'file-system-chat' : 'inbox-chat'
}

export const BRAINSTORM_GENERATION_TIMEOUT_MS = 10 * 60 * 1000

export const SPEC_GENERATION_TIMEOUT_MS = 10 * 60 * 1000

export function assertHarnessRequestCapabilities(
  driver: HarnessDriver,
  attachments: PromptAttachment[],
  _permissionLevel: PermissionLevel = 'auto_review'
): void {
  void _permissionLevel
  if (attachments.length && !driver.capabilities?.attachments) {
    throw new Error(`${driver.name} does not support prompt attachments.`)
  }
}

/** Whether a utility's scope applies to the given project/thread context. */
export function scopeAppliesToThread(
  scope: import('../../../lib/types').UtilityScope,
  projectId: string,
  threadId: string
): boolean {
  if (scope.level === 'global') return true
  if (scope.projectId !== projectId) return false
  if (scope.level === 'project') return true
  return scope.threadId === threadId
}

export function mcpDetail(
  utility: Extract<import('../../../lib/types').UtilityDefinition, { kind: 'mcp' }>
): string | undefined {
  if (utility.config.transport === 'stdio') {
    return `stdio · ${utility.config.command ?? ''}`
  }
  return `${utility.config.transport} · ${utility.config.url ?? ''}`
}

export function dedupeCapabilities(entries: AgentCapabilityEntry[]): AgentCapabilityEntry[] {
  const seen = new Set<string>()
  const result: AgentCapabilityEntry[] = []
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.name.toLocaleLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}
