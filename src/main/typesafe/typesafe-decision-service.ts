import type {
  TypesafeAvailability,
  TypesafeCheckResult,
  TypesafeDecision,
  TypesafeDecisionRequest,
  TypesafeFailure,
  TypesafeQuestionMap,
  TypesafeStatus
} from '../../lib/types'
import {
  isTypesafeCoolingDown,
  recordTypesafeOutcome,
  TYPESAFE_AVAILABILITY_CLOSED,
  type TypesafeAvailabilityState
} from '../../lib/typesafe/availability'
import {
  estimateTypesafeTokens,
  resolveTypesafeThresholds,
  reviewTypesafeAnswers,
  TYPESAFE_STATE_TOKEN_BUDGET,
  typesafeCostUsd,
  validateTypesafeQuestions
} from '../../lib/typesafe/policy'
import { Logger } from '../system/logger'
import type { TypesafeAuditLog } from './typesafe-audit'
import { callTypesafe, TYPESAFE_DEFAULT_TIMEOUT_MS } from './typesafe-client'
import type { TypesafeKeyResolver } from './typesafe-key-resolver'

/**
 * The question the connection check sends.
 *
 * Fixed state and a fixed question, so the check is deterministic and costs one
 * cheap call: it proves the key, the network path, the response shape and the
 * version that answered, without sending anything belonging to the user.
 */
const CHECK_STATE = 'A short, ordinary sentence.'
const CHECK_QUESTIONS: TypesafeQuestionMap = {
  greeting: {
    type: 'noul',
    instructions: 'Is this text a greeting?',
    criteria: { true: 'A greeting', false: 'Not a greeting' }
  }
}

/**
 * The app's one TypeSafe capability.
 *
 * Every seam and every caller talks to this class and never to the wire, so the
 * key, the endpoint, the model id and the confidence floors all live in a
 * single place. Two properties are deliberate and load bearing:
 *
 * - Nothing here throws. Every failure becomes a typed outcome, which is what
 *   lets a seam fall back to the code it runs today without a special case.
 * - Nothing here blocks a turn. A dead key, an exhausted balance and an outage
 *   all end at the same in-memory breaker, so the cost of being unconfigured is
 *   one failed call and then a map lookup.
 */
export class TypesafeDecisionService {
  private availability: TypesafeAvailabilityState = TYPESAFE_AVAILABILITY_CLOSED
  /** Epoch ms of the last successful call, and the version that answered it. */
  private verifiedAt: number | undefined
  private verifiedModel: string | undefined
  /** Last failure, kept in memory only, for the Settings card to report. */
  private lastFailure: TypesafeFailure | undefined

  constructor(
    private readonly resolver: TypesafeKeyResolver,
    private readonly audit: TypesafeAuditLog
  ) {}

  /** Renderer-safe state. Never includes the key. */
  async getStatus(): Promise<TypesafeStatus> {
    const key = await this.resolver.resolve()
    return this.describe(key?.source ?? null, key?.detail)
  }

  /** Store the device key and report the new state. */
  async setKey(value: string): Promise<TypesafeStatus> {
    await this.resolver.store(value)
    this.resetVerification()
    return this.getStatus()
  }

  /** Forget the device key. A key held elsewhere is left exactly as it was. */
  async clearKey(): Promise<TypesafeStatus> {
    await this.resolver.clear()
    this.resetVerification()
    return this.getStatus()
  }

  /**
   * Send one real typed question and report what actually happened.
   *
   * This is the only path that proves a key works, so it deliberately ignores
   * the breaker: the user asked for the check, and one refused request costs
   * nothing. The outcome still feeds the breaker, so a rejected key does not
   * make every later decision retry it.
   */
  async check(): Promise<TypesafeCheckResult> {
    const key = await this.resolver.resolve()
    if (!key) {
      return { ok: false, status: 'not-configured', detail: 'No TypeSafe API key is configured.' }
    }

    const outcome = await callTypesafe({
      apiKey: key.value,
      state: CHECK_STATE,
      questions: CHECK_QUESTIONS,
      timeoutMs: TYPESAFE_DEFAULT_TIMEOUT_MS
    })
    this.availability = recordTypesafeOutcome(
      this.availability,
      outcome.status,
      Date.now(),
      outcome.status === 'answered' ? undefined : outcome.retryAfterMs
    )

    if (outcome.status === 'answered') {
      this.verifiedAt = Date.now()
      this.verifiedModel = outcome.model
      this.lastFailure = undefined
      await this.audit.append({
        at: this.verifiedAt,
        seam: 'connection-check',
        status: 'answered',
        model: outcome.model,
        ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
        latencyMs: outcome.latencyMs,
        questions: { greeting: 'noul' },
        answers: outcome.answers,
        thresholds: resolveTypesafeThresholds(),
        ...(outcome.usage ? { usage: outcome.usage, costUsd: typesafeCostUsd(outcome.usage) } : {})
      })
      return {
        ok: true,
        model: outcome.model,
        latencyMs: outcome.latencyMs,
        ...(outcome.usage ? { usage: outcome.usage } : {})
      }
    }

    this.lastFailure = {
      status: outcome.status,
      detail: outcome.detail,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
      at: Date.now()
    }
    Logger.dev('TypeSafe connection check failed:', outcome.status, outcome.detail)
    await this.audit.append({
      at: Date.now(),
      seam: 'connection-check',
      status: outcome.status,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
      latencyMs: outcome.latencyMs,
      questions: { greeting: 'noul' },
      thresholds: resolveTypesafeThresholds(),
      detail: outcome.detail
    })
    return {
      ok: false,
      status: outcome.status,
      detail: outcome.detail,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {})
    }
  }

  /**
   * Ask for one judgment.
   *
   * Returns `answered` only when every question also cleared its floor, so a
   * caller acts on a confident answer or on nothing at all. The body is wrapped
   * because a seam must be able to branch on this call and nothing else: a
   * dependency that throws, or a state that cannot be serialized, is this app's
   * fault and has to read as "no answer" rather than as a failed turn.
   */
  async decide(request: TypesafeDecisionRequest): Promise<TypesafeDecision> {
    try {
      return await this.runDecision(request)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      Logger.dev('TypeSafe decision failed unexpectedly:', error)
      return { status: 'invalid-response', detail }
    }
  }

  private async runDecision(request: TypesafeDecisionRequest): Promise<TypesafeDecision> {
    try {
      validateTypesafeQuestions(request.questions)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      Logger.dev('TypeSafe decision rejected locally:', detail)
      return { status: 'invalid-response', detail }
    }

    const estimatedTokens = estimateTypesafeTokens(request.state, request.questions)
    if (estimatedTokens > TYPESAFE_STATE_TOKEN_BUDGET) {
      return {
        status: 'over-budget',
        detail: `TypeSafe state is roughly ${estimatedTokens} tokens, above the ${TYPESAFE_STATE_TOKEN_BUDGET} budget`
      }
    }

    const key = await this.resolver.resolve(request.threadId)
    if (!key) return { status: 'not-configured' }

    if (isTypesafeCoolingDown(this.availability, Date.now())) {
      // No socket is opened here: this is the whole cost of a dead key.
      return { status: 'cooling-down' }
    }

    const thresholds = resolveTypesafeThresholds(request.thresholds)
    const outcome = await callTypesafe({
      apiKey: key.value,
      state: request.state,
      questions: request.questions,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
    })
    this.availability = recordTypesafeOutcome(
      this.availability,
      outcome.status,
      Date.now(),
      outcome.status === 'answered' ? undefined : outcome.retryAfterMs
    )

    const questionTypes = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, question.type])
    )

    if (outcome.status !== 'answered') {
      this.lastFailure = {
        status: outcome.status,
        detail: outcome.detail,
        ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
        at: Date.now()
      }
      await this.audit.append({
        at: Date.now(),
        seam: request.seam,
        ...(request.threadId ? { threadId: request.threadId } : {}),
        status: outcome.status,
        ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
        latencyMs: outcome.latencyMs,
        questions: questionTypes,
        thresholds,
        detail: outcome.detail
      })
      return { status: outcome.status, detail: outcome.detail }
    }

    const review = reviewTypesafeAnswers(outcome.answers, thresholds)
    this.verifiedAt = Date.now()
    this.verifiedModel = outcome.model
    this.lastFailure = undefined
    await this.audit.append({
      at: this.verifiedAt,
      seam: request.seam,
      ...(request.threadId ? { threadId: request.threadId } : {}),
      status: review.accepted ? 'answered' : 'below-threshold',
      model: outcome.model,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
      latencyMs: outcome.latencyMs,
      questions: questionTypes,
      answers: outcome.answers,
      thresholds,
      ...(review.accepted ? {} : { failed: review.failed }),
      ...(outcome.usage ? { usage: outcome.usage, costUsd: typesafeCostUsd(outcome.usage) } : {})
    })

    if (!review.accepted) {
      return {
        status: 'below-threshold',
        detail: `TypeSafe answered below the confidence floor for: ${review.failed.join(', ')}`
      }
    }

    return {
      status: 'answered',
      answers: outcome.answers,
      model: outcome.model,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
      latencyMs: outcome.latencyMs,
      ...(outcome.usage ? { usage: outcome.usage } : {})
    }
  }

  private describe(source: TypesafeStatus['keySource'], detail?: string): TypesafeStatus {
    return {
      hasKey: source !== null,
      keySource: source,
      ...(detail ? { keySourceDetail: detail } : {}),
      availability: this.availabilityFor(source),
      verified: this.verifiedAt !== undefined,
      ...(this.verifiedModel ? { model: this.verifiedModel } : {}),
      secureStorageAvailable: this.resolver.isStorageAvailable(),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
      ...(this.verifiedAt !== undefined ? { verifiedAt: this.verifiedAt } : {})
    }
  }

  private availabilityFor(source: TypesafeStatus['keySource']): TypesafeAvailability {
    if (source === null) return 'unconfigured'
    if (this.lastFailure) {
      if (this.lastFailure.status === 'rejected') return 'rejected'
      if (this.lastFailure.status === 'rate-limited') return 'rate-limited'
      if (this.lastFailure.status === 'unavailable') return 'unavailable'
    }
    return this.verifiedAt !== undefined ? 'ready' : 'unverified'
  }

  /**
   * A stored or cleared key invalidates what the old one proved, and closes a
   * breaker the old key opened, so a fixed key works on the next call without
   * anyone hunting for a reset.
   */
  private resetVerification(): void {
    this.verifiedAt = undefined
    this.verifiedModel = undefined
    this.lastFailure = undefined
    this.availability = TYPESAFE_AVAILABILITY_CLOSED
  }
}
