import { Logger } from '../../system/logger'
import type { AgentProviderIssue } from '../../../lib/types'
import {
  classifyProviderIssue,
  isUsageResetWaitIssue,
  parseUsageResetAt
} from '../../../lib/provider-issue'
import type { GenerateTitleOptions, SendPromptOptions } from '../driver.interface'
import type {
  OneShotOutcome,
  PersistentCliSession,
  TitleAttemptAccounting,
  TitleModelCandidate
} from './persistent-cli-types'
import type { AuxiliaryCandidateVerdict, AuxiliaryVerdictBlockMap } from './auxiliary-verdict-store'
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
   * Auxiliary candidates this driver refuses to probe, shared by every auxiliary
   * run. Keyed by `providerId/modelId` because a provider window closes per
   * account and model, not per job, and because a hard rejection retires one
   * provider or one model id rather than the whole app. Durable when the driver
   * supplies `AuxiliaryVerdictStore`, so a restart reuses what it already proved.
   */
  quotaBlocks: AuxiliaryVerdictBlockMap
  createSession: (projectPath: string, title: string) => Promise<string>
  sendPrompt: (projectPath: string, options: SendPromptOptions) => Promise<void>
  requireSession: (projectPath: string, sessionId: string) => Promise<PersistentCliSession>
  abort: (projectPath: string, sessionId: string) => Promise<void>
  deleteSession: (projectPath: string, sessionId: string) => Promise<void>
}

/**
 * One candidate the provider already rejected (usage reset, auth, withdrawn
 * model or region lock), and when it may be probed again.
 */
export type AuxiliaryQuotaBlock = AuxiliaryCandidateVerdict

/**
 * Longest a blocked candidate is skipped. Providers report multi-day quota
 * windows and this verdict is persisted, so the block is capped rather than
 * honoured verbatim: the candidate is probed again once the cap passes, which
 * keeps a misparsed or already-lifted reset from retiring an auxiliary path for
 * days.
 */
const AUXILIARY_QUOTA_BLOCK_MAX_MS = 6 * 60 * 60 * 1000

/**
 * How long one provider stays out of auxiliary routing after it rejected the
 * account itself (expired key, revoked OAuth, billing, free-tier gate). Capped
 * rather than honoured forever, so a rejected provider is re-probed within the
 * hour even if the user never fixes the credential.
 */
const AUXILIARY_AUTH_BLOCK_MAX_MS = 30 * 60 * 1000

/**
 * How long one model id stays out of auxiliary routing after its provider
 * withdrew the id (deprecated, unsupported, region-locked, unavailable).
 *
 * A week rather than an hour, because these are the two failure classes that are
 * facts about the catalog instead of about a quota window: a deprecated model id
 * does not come back, and a region lock is a property of the account's country.
 * The verdict is also persisted now, so an hour-long cap only meant that every
 * launch re-paid the probe to relearn the same permanent answer: on one Windows
 * machine four such candidates cost about 37 seconds of harness processes per
 * launch. A week still re-probes a temporarily unavailable model, because the
 * store cannot tell a withdrawal from an outage the provider phrased that way.
 */
const AUXILIARY_DEAD_MODEL_BLOCK_MAX_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Failures that mean the model id itself is gone rather than the request being
 * unlucky. Checked before provider-level classification because a withdrawn
 * model arrives under the same 403/410 statuses a rejected account uses.
 */
const WITHDRAWN_MODEL_PATTERN =
  /deprecat|no longer (?:available|supported)|model (?:is )?(?:not found|unavailable|does not exist)|unsupported model/iu

/** A model the provider refuses to serve in the user's region (also a 403). */
const REGION_LOCK_PATTERN = /not available in your (?:country|region)|regionerror/iu

/** Verdict for one candidate failure: what it retires, and until when. */
export interface AuxiliaryFailureBlock {
  /** `provider` retires every candidate that provider serves; `model` only this id. */
  scope: 'provider' | 'model'
  /** Epoch ms the retired candidates may be probed again. */
  until: number
  /** Why they were retired, kept for the attempt ledger and diagnostics. */
  reason: string
}

/** HTTP status a driver-formatted failure carries in its prefix (`403: {...}`). */
function failureStatusCode(message: string): number | undefined {
  const match = /(?:^|[\s(])(\d{3})\)?\s*:/u.exec(message)
  return match?.[1] ? Number(match[1]) : undefined
}

/** First line of a provider failure, bounded, for the ledger and the log. */
function failureSummary(message: string): string {
  const line = message.trim().split('\n')[0]?.trim() ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * Decide whether one candidate failure is worth another candidate's harness
 * process. A null verdict means the failure is ambiguous (empty answer, dropped
 * transport, transient upstream error) and the next candidate is tried.
 *
 * The two hard classes are the ones that fail identically for every attempt
 * against the same target: the provider rejected the account itself (expired
 * key, revoked OAuth, billing, free-tier gate), or it withdrew the model id.
 * Both used to be treated as "pass" and the run walked the entire candidate
 * list, spawning one harness process per candidate: ten free models on an
 * account whose key had expired cost 58 seconds of background work per new
 * thread, and repeated on the next thread.
 */
function hardFailureBlock(
  message: string,
  nowMs: number,
  issue?: AgentProviderIssue | null
): AuxiliaryFailureBlock | null {
  const summary = failureSummary(message)
  if (!summary) return null
  if (WITHDRAWN_MODEL_PATTERN.test(summary)) {
    return {
      scope: 'model',
      until: nowMs + AUXILIARY_DEAD_MODEL_BLOCK_MAX_MS,
      reason: `provider withdrew this model (${summary})`
    }
  }
  if (REGION_LOCK_PATTERN.test(summary)) {
    return {
      scope: 'model',
      until: nowMs + AUXILIARY_DEAD_MODEL_BLOCK_MAX_MS,
      reason: `model is region-locked (${summary})`
    }
  }
  const kind = issue?.kind ?? classifyProviderIssue(message, failureStatusCode(message))
  if (kind === 'authentication' || kind === 'billing') {
    return {
      scope: 'provider',
      until: nowMs + AUXILIARY_AUTH_BLOCK_MAX_MS,
      reason: `provider rejected the account (${kind}: ${summary})`
    }
  }
  return null
}

/**
 * Retire the candidates one hard failure just proved unusable, so the rest of
 * this run skips them without spawning a harness process, and so does every
 * later auxiliary run, in this process and after a restart (the driver's verdict
 * store writes them through).
 *
 * A provider-scoped verdict retires every candidate of that provider in this
 * run's list, not only the failing one: the same credentials and region serve
 * them all, so each remaining candidate would only rediscover the rejection.
 *
 * `alwaysProbeKey` is the run's own fallback model, which stays probeable: it
 * is the model the user's real traffic already runs on, and a free-tier gate
 * or a region lock on a sibling model must not retire the one candidate that
 * is known to answer for this thread.
 */
function rememberHardFailure(
  host: OneShotHost,
  candidates: readonly TitleModelCandidate[],
  failed: TitleModelCandidate,
  block: AuxiliaryFailureBlock,
  alwaysProbeKey: string
): void {
  const retired =
    block.scope === 'provider'
      ? candidates.filter(
          (candidate) =>
            candidate.providerId === failed.providerId &&
            auxiliaryCandidateKey(candidate) !== alwaysProbeKey
        )
      : [failed].filter((candidate) => auxiliaryCandidateKey(candidate) !== alwaysProbeKey)
  if (retired.length === 0) return
  for (const candidate of retired) {
    host.quotaBlocks.set(auxiliaryCandidateKey(candidate), {
      resetAt: block.until,
      reason: block.reason
    })
  }
  Logger.info('Auxiliary candidates retired after a hard rejection', {
    driverId: host.driverName,
    candidate: auxiliaryCandidateKey(failed),
    scope: block.scope,
    retired: retired.map(auxiliaryCandidateKey),
    until: new Date(block.until).toISOString(),
    reason: block.reason
  })
}

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

/**
 * A provider answer that describes the model, not the request.
 *
 * These are the rejections a retry cannot improve: a model this provider does not
 * serve in the user's country, one the account's subscription does not include,
 * or one already retired from the catalog. Transport errors, empty responses and
 * timeouts are deliberately left out, because the next attempt may well answer.
 */
const UNAVAILABLE_CANDIDATE_PATTERN = /^\s*4(?:00|03|04)\b/u

/**
 * Remember that a provider refuses a candidate outright.
 *
 * A rejected model is rejected for every job that names it, and payment is one
 * disposable harness process per attempt: a search sweep over hundreds of threads
 * paid the same "not available in your country" and "subscription required"
 * answers once per thread, which held the sweep below the model that could
 * actually answer. The verdict is remembered on the same per-account map a usage
 * reset uses, for the same cap, so a renewed subscription or a widened region is
 * probed again instead of being ignored forever.
 */
function rememberUnavailableCandidate(
  host: OneShotHost,
  candidate: TitleModelCandidate,
  error: string
): void {
  if (!UNAVAILABLE_CANDIDATE_PATTERN.test(error)) return
  const candidateKey = auxiliaryCandidateKey(candidate)
  host.quotaBlocks.set(candidateKey, {
    resetAt: Date.now() + AUXILIARY_QUOTA_BLOCK_MAX_MS,
    reason: `the provider rejected this model (${error.slice(0, 120)})`
  })
  Logger.info('Auxiliary candidate held back after a provider rejection', {
    driverId: host.driverName,
    candidate: candidateKey,
    blockedForMs: AUXILIARY_QUOTA_BLOCK_MAX_MS
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
  timeoutMs: number = TITLE_GENERATION_TIMEOUT_MS,
  preparePrompt?: (candidate: { providerId?: string; modelId?: string }) => string
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
  /** The run's own fallback model is never retired by a sibling's rejection. */
  const fallbackKey = auxiliaryCandidateKey(fallback)
  let authFailed = false
  // Restore verdicts an earlier launch already proved before judging the first
  // candidate. This is the one place the run waits on the verdict file, and it
  // happens once per process, so a restored block skips its harness process
  // exactly like an in-memory one.
  await host.quotaBlocks.ready?.()

  for (let index = 0; index < attempts.length; index++) {
    const candidate = attempts[index]
    const candidateKey = auxiliaryCandidateKey(candidate)
    const block = host.quotaBlocks.get(candidateKey)
    if (block) {
      if (block.resetAt > Date.now()) {
        // The account already reported this window as closed (now, or in a
        // previous launch that persisted it): skip it without spawning a harness
        // process, and record the skip so the ledger shows a candidate that was
        // deliberately passed over rather than one that ran.
        accounted.push(buildTitleAttempt(index + 1, candidate, false, `Skipped: ${block.reason}`))
        continue
      }
      host.quotaBlocks.delete(candidateKey)
    }
    let candidatePrompt: string
    try {
      candidatePrompt = preparePrompt ? preparePrompt(candidate) : promptText
    } catch (error) {
      accounted.push(buildTitleAttempt(index + 1, candidate, false, describeTitleFailure(error)))
      continue
    }
    const sessionId = await host.createSession(projectPath, 'Auxiliary one-shot')
    host.titleTurns.register(sessionId)
    const completion = host.titleTurns.wait(sessionId, host.driverName, timeoutMs)
    try {
      // Observe the timeout concurrently: some drivers keep sendPrompt pending
      // until the entire turn finishes, so awaiting it first defeats the timer.
      await Promise.all([
        host.sendPrompt(projectPath, {
          sessionId,
          settings: {
            ...options.settings,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            thinkingLevel: 'minimal',
            inferenceMode: 'normal',
            permissionLevel: 'auto_review'
          },
          text: candidatePrompt,
          attachments: [],
          readOnly: true,
          allowedTools: [],
          minimalContext: true
        }),
        completion.promise
      ])
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
        rememberUnavailableCandidate(host, candidate, response.error)
        const retirement = hardFailureBlock(response.error, Date.now())
        if (retirement) {
          if (retirement.scope === 'provider') authFailed = true
          rememberHardFailure(host, attempts, candidate, retirement, fallbackKey)
        }
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
      const retirement = hardFailureBlock(issue?.message ?? fallbackReason, Date.now(), issue)
      if (retirement) {
        if (retirement.scope === 'provider') authFailed = true
        rememberHardFailure(host, attempts, candidate, retirement, fallbackKey)
      }
      rememberQuotaBlock(host, candidateKey, issue)
      Logger.dev(
        `${host.driverName} one-shot model ${candidate.providerId}/${candidate.modelId} unavailable:`,
        error
      )
      accounted.push(buildTitleAttempt(index + 1, candidate, false, fallbackReason))
    } finally {
      completion.cancel()
      await boundedCleanup(() => host.abort(projectPath, sessionId))
      await boundedCleanup(() => host.deleteSession(projectPath, sessionId))
      host.titleTurns.unregister(sessionId)
    }
  }
  return { value: null, authFailed, attempts: accounted }
}

/** An unresponsive transport must not defeat the completion timeout during cleanup. */
async function boundedCleanup(operation: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
