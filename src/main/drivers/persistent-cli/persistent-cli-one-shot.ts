import { Logger } from '../../system/logger'
import type { AgentProviderIssue } from '../../../lib/types'
import { isUsageResetWaitIssue, parseUsageResetAt } from '../../../lib/provider-issue'
import type { GenerateTitleOptions, SendPromptOptions } from '../driver.interface'
import type {
  OneShotOutcome,
  PersistentCliSession,
  TitleAttemptAccounting,
  TitleModelCandidate
} from './persistent-cli-types'
import {
  buildTitleAttempt,
  describeTitleFailure,
  TITLE_GENERATION_TIMEOUT_MS,
  TitleTurnProviderIssueError,
  type TitleTurnRegistry
} from './persistent-cli-title'

/** Driver callbacks an auxiliary one-shot run needs from its owner. */
export interface OneShotHost {
  driverName: string
  titleTurns: TitleTurnRegistry
  /**
   * Account-scoped usage-reset blocks, shared by every auxiliary run on this
   * driver instance. Keyed by `providerId/modelId` because a provider window
   * closes per account and model, not per job.
   */
  quotaBlocks: Map<string, AuxiliaryQuotaBlock>
  createSession: (projectPath: string, title: string) => Promise<string>
  sendPrompt: (projectPath: string, options: SendPromptOptions) => Promise<void>
  requireSession: (projectPath: string, sessionId: string) => Promise<PersistentCliSession>
  abort: (projectPath: string, sessionId: string) => Promise<void>
  deleteSession: (projectPath: string, sessionId: string) => Promise<void>
}

/** One candidate whose provider reported a usage reset, and when its window reopens. */
export interface AuxiliaryQuotaBlock {
  /** Epoch ms this candidate may be probed again. */
  resetAt: number
  /** Provider-reported reason, kept for the attempt ledger and diagnostics. */
  reason: string
}

/**
 * Longest a blocked candidate is skipped. Providers report multi-day quota
 * windows and this memory is in-process only, so the block is capped rather
 * than honoured verbatim: the candidate is probed again once the cap passes,
 * which keeps a misparsed or already-lifted reset from retiring an auxiliary
 * path for days.
 */
const AUXILIARY_QUOTA_BLOCK_MAX_MS = 6 * 60 * 60 * 1000

/** Identity a usage reset blocks: one account serving one provider/model pair. */
export function auxiliaryCandidateKey(candidate: TitleModelCandidate): string {
  return `${candidate.providerId}/${candidate.modelId}`
}

/**
 * Verdict for one auxiliary route: the earliest moment every named candidate is
 * probeable again, or null while at least one of them is free.
 *
 * Pure by design, so the same decision a one-shot run makes when it skips a
 * blocked candidate can be asked about a whole route before any work is queued
 * for it. The caller must name the complete route: a candidate left out of the
 * list would make a closed route look open, or an open one look closed.
 */
export function auxiliaryBlockUntil(
  candidates: readonly TitleModelCandidate[],
  blocks: ReadonlyMap<string, AuxiliaryQuotaBlock>,
  nowMs: number
): number | null {
  let blockedUntil: number | null = null
  let tested = 0
  for (const candidate of candidates) {
    if (!candidate.providerId || !candidate.modelId) continue
    tested += 1
    const block = blocks.get(auxiliaryCandidateKey(candidate))
    // Exact parity with the runner's own skip test (`block.resetAt > now`): a
    // missing, expired, or unusable deadline means the candidate is probed.
    if (!block || !(block.resetAt > nowMs)) return null
    blockedUntil = blockedUntil === null ? block.resetAt : Math.min(blockedUntil, block.resetAt)
  }
  return tested === 0 ? null : blockedUntil
}

/**
 * Remember a provider-reported usage reset for one candidate.
 *
 * An account-level limit fails identically for every queued background job, so
 * without this memory a blocked account pays a fresh harness process for title,
 * grading, lesson, heartbeat, and cheap-model runs alike, once per job, until
 * its window reopens: Codex's usage-limit failures repeated on every grading row
 * for hours because the reset time the provider reported was parsed and then
 * discarded.
 */
function rememberQuotaBlock(
  host: OneShotHost,
  candidateKey: string,
  issue: AgentProviderIssue | null
): void {
  if (!issue || !isUsageResetWaitIssue(issue)) return
  const resetAt = issue.retryAt ?? parseUsageResetAt(issue.message)
  const now = Date.now()
  if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= now) return
  const blockedUntil = Math.min(resetAt, now + AUXILIARY_QUOTA_BLOCK_MAX_MS)
  host.quotaBlocks.set(candidateKey, {
    resetAt: blockedUntil,
    reason: `usage limit reported until ${new Date(resetAt).toISOString()}`
  })
  Logger.info('Auxiliary candidate held back until its usage window reopens', {
    driverId: host.driverName,
    candidate: candidateKey,
    reportedResetAt: new Date(resetAt).toISOString(),
    blockedUntil: new Date(blockedUntil).toISOString()
  })
}

/** Run one auxiliary one-shot completion per disposable session, cheapest candidate first. */
export async function runOneShotWithCandidates(
  host: OneShotHost,
  projectPath: string,
  options: GenerateTitleOptions,
  candidates: TitleModelCandidate[],
  promptText: string,
  validate: (raw: string) => string | null,
  timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS
): Promise<OneShotOutcome> {
  const fallback = {
    providerId: options.settings.providerId,
    modelId: options.settings.modelId
  }
  const attempts = [...candidates, fallback].filter(
    (candidate, index, all) =>
      Boolean(candidate.providerId && candidate.modelId) &&
      all.findIndex(
        (other) => other.providerId === candidate.providerId && other.modelId === candidate.modelId
      ) === index
  )
  const accounted: TitleAttemptAccounting[] = []

  for (let index = 0; index < attempts.length; index++) {
    const candidate = attempts[index]
    const candidateKey = auxiliaryCandidateKey(candidate)
    const block = host.quotaBlocks.get(candidateKey)
    if (block) {
      if (block.resetAt > Date.now()) {
        // The account already reported this window as closed: skip it without
        // spawning a harness process, and record the skip so the ledger shows a
        // candidate that was deliberately passed over rather than one that ran.
        accounted.push(buildTitleAttempt(index + 1, candidate, false, `Skipped: ${block.reason}`))
        continue
      }
      host.quotaBlocks.delete(candidateKey)
    }
    const sessionId = await host.createSession(projectPath, 'Auxiliary one-shot')
    host.titleTurns.register(sessionId)
    const completion = host.titleTurns.wait(sessionId, host.driverName, timeoutMs)
    try {
      await host.sendPrompt(projectPath, {
        sessionId,
        settings: {
          ...options.settings,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          thinkingLevel: 'minimal',
          inferenceMode: 'normal',
          permissionLevel: 'auto_review'
        },
        text: promptText,
        attachments: [],
        readOnly: true,
        allowedTools: []
      })
      await completion.promise
      // Read the live session record directly: a driver override may answer
      // from a native transcript or report [] for unresumable sessions, while
      // title generation always wants this disposable session's own mirror.
      const titleSession = await host.requireSession(projectPath, sessionId)
      const messages = titleSession.messages
      const response = [...messages].reverse().find((message) => message.role === 'assistant')
      if (response?.error) {
        // Surface the CLI's own failure text; without this the reason behind
        // a null score (session limit, auth, transport) is unrecoverable.
        Logger.dev(
          `${host.driverName} one-shot model ${candidate.providerId}/${candidate.modelId} failed: ${response.error}`
        )
        accounted.push(buildTitleAttempt(index + 1, candidate, false, response.error, response))
        continue
      }
      const raw = response?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      const value = raw ? validate(raw) : null
      if (value !== null) {
        accounted.push(buildTitleAttempt(index + 1, candidate, true, null, response))
        return { value, authFailed: false, attempts: accounted }
      }
      Logger.dev(
        `${host.driverName} one-shot model ${candidate.providerId}/${candidate.modelId} produced no usable response`,
        raw ? raw.slice(0, 300) : '(empty response)'
      )
      accounted.push(
        buildTitleAttempt(index + 1, candidate, false, 'No usable response produced', response)
      )
    } catch (error) {
      const fallbackReason = describeTitleFailure(error)
      const issue = error instanceof TitleTurnProviderIssueError ? error.issue : null
      if (issue?.kind === 'authentication') {
        accounted.push(buildTitleAttempt(index + 1, candidate, false, fallbackReason))
        if (index === attempts.length - 1) {
          return { value: null, authFailed: true, attempts: accounted }
        }
        continue
      }
      rememberQuotaBlock(host, candidateKey, issue)
      Logger.dev(
        `${host.driverName} one-shot model ${candidate.providerId}/${candidate.modelId} unavailable:`,
        error
      )
      accounted.push(buildTitleAttempt(index + 1, candidate, false, fallbackReason))
    } finally {
      completion.cancel()
      await host.abort(projectPath, sessionId).catch(() => undefined)
      await host.deleteSession(projectPath, sessionId).catch(() => undefined)
      host.titleTurns.unregister(sessionId)
    }
  }
  return { value: null, authFailed: false, attempts: accounted }
}
